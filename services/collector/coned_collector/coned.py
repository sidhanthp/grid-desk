import asyncio
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import httpx
import pyotp


logger = logging.getLogger("coned-collector")


LOGIN_URL = (
    "https://www.coned.com/sitecore/api/ssc/"
    "ConEdWeb-Foundation-Login-Areas-LoginAPI/User/0/Login"
)
MFA_URL = (
    "https://www.coned.com/sitecore/api/ssc/"
    "ConEdWeb-Foundation-Login-Areas-LoginAPI/User/0/VerifyFactor"
)
TOKEN_URL = (
    "https://www.coned.com/sitecore/api/ssc/"
    "ConEd-Cms-Services-Controllers-Opower/OpowerService/0/GetOPowerToken"
)
CUSTOMER_URL = "https://cned.opower.com/ei/edge/apis/multi-account-v1/cws/cned/customers/current"
GRAPHQL_URL = "https://cned.opower.com/ei/edge/apis/dsm-graphql-v1/cws/graphql"
RETURN_URL = "/en/accounts-billing/my-account/energy-use"


BILLING_ACCOUNTS_QUERY = """
query WBAS_BillingAccounts($first: Int, $onlyActive: Boolean) {
  billingAccountsConnection(first: $first) {
    edges { node {
      urn
      serviceAgreementsConnection(first: 10, onlyActive: $onlyActive) {
        edges { node {
          uuid serviceType
          servicePointsConnection { edges { node { uuid serviceType } } }
        } }
      }
    } }
  }
}
"""

REGISTERS_QUERY = """
query WRTAMI_GetRegisters($selectedAccount: ID, $saUuid: String, $spUuid: String) {
  billingAccountByAuthContext(selectedAccount: $selectedAccount) {
    serviceAgreementsConnection(onlyActive: true, matching: $saUuid) {
      edges { node { servicePointsConnection(matching: $spUuid) {
        edges { node { intervalReads(
          units: [KWH], serviceQuantityIdentifier: [NET_USAGE], onlyUnverifiedStreams: true
        ) { registerId } } }
      } } }
    }
  }
}
"""

USAGE_QUERY = """
query WRTAMI_GetRegisterUsage($selectedAccount: ID, $registerId: ID, $saUuid: String, $spUuid: String) {
  billingAccountByAuthContext(selectedAccount: $selectedAccount) {
    serviceAgreementsConnection(onlyActive: true, matching: $saUuid) {
      edges { node { servicePointsConnection(matching: $spUuid) {
        edges { node { intervalReads(
          registerId: $registerId, units: [KWH],
          serviceQuantityIdentifier: [NET_USAGE], onlyUnverifiedStreams: true
        ) { reads { timeInterval measuredAmount { value } } } } }
      } } }
    }
  }
}
"""

HISTORY_QUERY_TEMPLATE = """
query WRTAMI_GetHistoricalUsage($selectedAccount: ID, $saUuid: String, $spUuid: String) {{
  billingAccountByAuthContext(selectedAccount: $selectedAccount) {{
    serviceAgreementsConnection(onlyActive: true, matching: $saUuid) {{
      edges {{ node {{ servicePointsConnection(matching: $spUuid) {{
        edges {{ node {{ readStreams(
          timeInterval: "{time_interval}", readResolution: HOUR
        ) {{ netUsage {{ reads {{ timeInterval measuredAmount {{ value }} }} }} }} }} }}
      }} }} }}
    }}
  }}
}}
"""


@dataclass(frozen=True)
class IntervalReading:
    starts_at: datetime
    ends_at: datetime
    kwh: float

    @property
    def average_kw(self) -> float:
        hours = (self.ends_at - self.starts_at).total_seconds() / 3600
        return self.kwh / hours


class MFARequiredError(RuntimeError):
    pass


def parse_reads(reads: list[dict[str, Any]]) -> list[IntervalReading]:
    parsed: list[IntervalReading] = []
    for read in reads:
        measured = read.get("measuredAmount")
        if not measured or measured.get("value") is None:
            continue
        start_value, end_value = read["timeInterval"].split("/", 1)
        starts_at = datetime.fromisoformat(start_value.replace("Z", "+00:00"))
        ends_at = datetime.fromisoformat(end_value.replace("Z", "+00:00"))
        if starts_at.tzinfo is None or ends_at.tzinfo is None:
            raise ValueError("Con Edison returned a timestamp without a timezone")
        parsed.append(IntervalReading(starts_at, ends_at, float(measured["value"])))
    return parsed


class ConEdClient:
    def __init__(
        self,
        email: str,
        password: str,
        totp_secret: str,
        account_urn: str | None = None,
    ) -> None:
        self.email = email
        self.password = password
        self.totp_secret = totp_secret
        self.account_urn = account_urn
        self.headers = {
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 Chrome/136 Safari/537.36"
            ),
            "Referer": "https://www.coned.com/",
        }
        self._client: httpx.AsyncClient | None = None
        self._authenticated = False
        self._mfa_pending = False
        self._lock = asyncio.Lock()

    def _new_client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            headers=self.headers,
            follow_redirects=True,
            timeout=30,
        )

    async def close(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None
        self._authenticated = False
        self._mfa_pending = False

    async def _reset_session(self) -> None:
        await self.close()
        self._client = self._new_client()

    def export_session(self) -> str:
        if not self._client or not self._authenticated:
            raise RuntimeError("No authenticated Con Edison session is available")
        cookies = [
            {
                "name": cookie.name,
                "value": cookie.value,
                "domain": cookie.domain,
                "path": cookie.path,
            }
            for cookie in self._client.cookies.jar
        ]
        return json.dumps(cookies, separators=(",", ":"))

    async def restore_session(self, snapshot: str) -> bool:
        try:
            cookies = json.loads(snapshot)
            if not isinstance(cookies, list) or len(cookies) > 100:
                return False
            validated: list[tuple[str, str, str, str]] = []
            for cookie in cookies:
                if not isinstance(cookie, dict):
                    return False
                name = cookie.get("name")
                value = cookie.get("value")
                domain = cookie.get("domain") or ""
                path = cookie.get("path") or "/"
                if not all(isinstance(item, str) for item in (name, value, domain, path)):
                    return False
                validated.append((name, value, domain, path))
            client = self._new_client()
            for name, value, domain, path in validated:
                client.cookies.set(name, value, domain=domain, path=path)
            await self.close()
            self._client = client
            try:
                await self._finish_authentication(client, None)
                self._authenticated = True
            except (RuntimeError, httpx.HTTPError):
                # An expired Con Edison/Opower session can still contain the
                # remembered-device cookie that prevents another MFA prompt.
                # Preserve those cookies and let fetch_latest perform a full
                # credential login on the same recognized device.
                self._authenticated = False
                self._clear_opower_headers(client)
                logger.info(
                    "Restored Con Edison device cookies; authenticated login is required"
                )
            return True
        except (ValueError, TypeError, KeyError, json.JSONDecodeError):
            await self._reset_session()
            return False

    @staticmethod
    def _clear_opower_headers(client: httpx.AsyncClient) -> None:
        client.headers.pop("Authorization", None)
        client.headers.pop("Opower-Selected-Entities", None)

    async def _login(self, client: httpx.AsyncClient) -> None:
        self._clear_opower_headers(client)
        await self._authenticate(client)
        self._authenticated = True

    async def _recover_authentication(self, client: httpx.AsyncClient) -> None:
        try:
            await self._finish_authentication(client, None)
            self._authenticated = True
            logger.info("Refreshed the expired Con Edison access token")
            return
        except httpx.HTTPStatusError as error:
            if error.response.status_code not in {401, 403}:
                raise
        except RuntimeError:
            pass

        logger.info("Access-token refresh failed; retrying the recognized-device login")
        self._authenticated = False
        await self._login(client)
        logger.info("Reauthenticated with the remembered Con Edison device")

    async def fetch_latest(self) -> list[IntervalReading]:
        async with self._lock:
            if not self._client:
                self._client = self._new_client()

            for attempt in range(2):
                client = self._client
                try:
                    if not self._authenticated:
                        await self._login(client)
                    account_urn, service_agreement, service_point = (
                        await self._select_electric_account(client)
                    )
                    register_id = await self._get_register(
                        client, account_urn, service_agreement, service_point
                    )
                    reads = await self._get_usage(
                        client, account_urn, service_agreement, service_point, register_id
                    )
                    return parse_reads(reads)
                except httpx.HTTPStatusError as error:
                    if attempt == 0 and error.response.status_code in {401, 403}:
                        await self._recover_authentication(client)
                        continue
                    raise

            raise RuntimeError("Con Edison session could not be refreshed")

    async def fetch_history(
        self,
        end_at: datetime,
        days: int = 730,
    ) -> list[IntervalReading]:
        """Fetch hourly history without overlapping the recent 15-minute stream."""
        async with self._lock:
            if not self._client or not self._authenticated:
                raise RuntimeError("Con Edison must be authenticated before backfill")

            account_urn, service_agreement, service_point = (
                await self._select_electric_account(self._client)
            )
            local_zone = ZoneInfo("America/New_York")
            window_end = end_at.astimezone(local_zone).replace(
                minute=0, second=0, microsecond=0
            )
            earliest = window_end - timedelta(days=days)
            readings: list[IntervalReading] = []

            while window_end > earliest:
                # This consumer endpoint enforces a 720-hour ceiling. Use 29
                # local days so daylight-saving transitions cannot cross it.
                window_start = max(earliest, window_end - timedelta(days=29))
                reads = await self._get_hourly_history(
                    self._client,
                    account_urn,
                    service_agreement,
                    service_point,
                    window_start,
                    window_end,
                )
                readings.extend(parse_reads(reads))
                window_end = window_start

            deduplicated = {reading.starts_at: reading for reading in readings}
            return [deduplicated[key] for key in sorted(deduplicated)]

    async def submit_mfa(self, code: str) -> None:
        async with self._lock:
            if not self._client or not self._mfa_pending:
                raise RuntimeError("No Con Edison verification challenge is pending")
            await self._verify_mfa(self._client, code)
            self._authenticated = True
            self._mfa_pending = False

    async def _authenticate(self, client: httpx.AsyncClient) -> None:
        response = await client.post(
            LOGIN_URL,
            data={
                "LoginEmail": self.email,
                "LoginPassword": self.password,
                "LoginRememberMe": True,
                "ReturnUrl": RETURN_URL,
                "OpenIdRelayState": "",
            },
        )
        response.raise_for_status()
        login = response.json()
        if not login.get("login"):
            raise RuntimeError("Con Edison rejected the login")

        redirect_url = login.get("authRedirectUrl")
        if not redirect_url:
            if not login.get("newDevice"):
                raise RuntimeError("Con Edison login did not return a usable session")
            if not login.get("noMfa"):
                self._mfa_pending = True
                if not self.totp_secret:
                    raise MFARequiredError(
                        "Con Edison requires extra verification for this Railway device"
                    )
                await self._verify_mfa(client, pyotp.TOTP(self.totp_secret).now())
                return

        await self._finish_authentication(client, redirect_url)

    async def _verify_mfa(self, client: httpx.AsyncClient, code: str) -> None:
        mfa_response = await client.post(
            MFA_URL,
            json={
                "MFACode": code,
                "ReturnUrl": RETURN_URL,
                "OpenIdRelayState": "",
            },
        )
        mfa_response.raise_for_status()
        mfa = mfa_response.json()
        if not mfa.get("code"):
            raise RuntimeError("Con Edison rejected the verification code")
        await self._finish_authentication(client, mfa.get("authRedirectUrl"))

    async def _finish_authentication(
        self, client: httpx.AsyncClient, redirect_url: str | None
    ) -> None:
        if redirect_url:
            redirect = await client.get(redirect_url)
            redirect.raise_for_status()

        token_response = await client.get(TOKEN_URL)
        token_response.raise_for_status()
        token = token_response.json()
        if not isinstance(token, str) or not token:
            raise RuntimeError("Con Edison did not return an Opower access token")

        client.headers["Authorization"] = f"Bearer {token}"
        customer_response = await client.get(CUSTOMER_URL)
        customer_response.raise_for_status()
        customer_uuid = customer_response.json()["uuid"]
        client.headers["Opower-Selected-Entities"] = (
            f'["urn:opower:customer:uuid:{customer_uuid}"]'
        )

    async def _graphql(
        self,
        client: httpx.AsyncClient,
        operation_name: str,
        query: str,
        variables: dict[str, Any],
    ) -> dict[str, Any]:
        response = await client.post(
            GRAPHQL_URL,
            json={"operationName": operation_name, "query": query, "variables": variables},
        )
        response.raise_for_status()
        payload = response.json()
        if payload.get("errors"):
            raise RuntimeError(f"Opower {operation_name} failed: {payload['errors']}")
        return payload["data"]

    async def _select_electric_account(
        self, client: httpx.AsyncClient
    ) -> tuple[str, str, str]:
        data = await self._graphql(
            client,
            "WBAS_BillingAccounts",
            BILLING_ACCOUNTS_QUERY,
            {"first": 25, "onlyActive": True},
        )
        accounts = data["billingAccountsConnection"]["edges"]
        if self.account_urn:
            accounts = [edge for edge in accounts if edge["node"]["urn"] == self.account_urn]
        else:
            accounts = [
                edge
                for edge in accounts
                if any(
                    agreement["node"]["serviceType"] == "ELECTRICITY"
                    for agreement in edge["node"]["serviceAgreementsConnection"]["edges"]
                )
            ]
        if len(accounts) != 1:
            raise RuntimeError(
                "Expected one active electric account. Set CONED_ACCOUNT_URN to choose one."
            )

        account = accounts[0]["node"]
        agreement = next(
            edge["node"]
            for edge in account["serviceAgreementsConnection"]["edges"]
            if edge["node"]["serviceType"] == "ELECTRICITY"
        )
        point = next(
            edge["node"]
            for edge in agreement["servicePointsConnection"]["edges"]
            if edge["node"]["serviceType"] == "ELECTRICITY"
        )
        return account["urn"], agreement["uuid"], point["uuid"]

    async def _get_register(
        self,
        client: httpx.AsyncClient,
        account_urn: str,
        service_agreement: str,
        service_point: str,
    ) -> str:
        data = await self._graphql(
            client,
            "WRTAMI_GetRegisters",
            REGISTERS_QUERY,
            {
                "selectedAccount": account_urn,
                "saUuid": service_agreement,
                "spUuid": service_point,
            },
        )
        points = data["billingAccountByAuthContext"]["serviceAgreementsConnection"]["edges"]
        interval_reads = points[0]["node"]["servicePointsConnection"]["edges"][0]["node"][
            "intervalReads"
        ]
        if not interval_reads:
            raise RuntimeError("No interval register was available for this meter")
        return interval_reads[0]["registerId"]

    async def _get_usage(
        self,
        client: httpx.AsyncClient,
        account_urn: str,
        service_agreement: str,
        service_point: str,
        register_id: str,
    ) -> list[dict[str, Any]]:
        data = await self._graphql(
            client,
            "WRTAMI_GetRegisterUsage",
            USAGE_QUERY,
            {
                "selectedAccount": account_urn,
                "registerId": register_id,
                "saUuid": service_agreement,
                "spUuid": service_point,
            },
        )
        points = data["billingAccountByAuthContext"]["serviceAgreementsConnection"]["edges"]
        return points[0]["node"]["servicePointsConnection"]["edges"][0]["node"][
            "intervalReads"
        ][0]["reads"]

    async def _get_hourly_history(
        self,
        client: httpx.AsyncClient,
        account_urn: str,
        service_agreement: str,
        service_point: str,
        starts_at: datetime,
        ends_at: datetime,
    ) -> list[dict[str, Any]]:
        time_interval = f"{starts_at.isoformat()}/{ends_at.isoformat()}"
        query = HISTORY_QUERY_TEMPLATE.format(time_interval=time_interval)
        data = await self._graphql(
            client,
            "WRTAMI_GetHistoricalUsage",
            query,
            {
                "selectedAccount": account_urn,
                "saUuid": service_agreement,
                "spUuid": service_point,
            },
        )
        points = data["billingAccountByAuthContext"]["serviceAgreementsConnection"][
            "edges"
        ]
        streams = points[0]["node"]["servicePointsConnection"]["edges"][0]["node"][
            "readStreams"
        ]["netUsage"]
        return streams[0]["reads"] if streams else []
