from datetime import UTC, datetime

import httpx

from coned_collector.coned import ConEdClient, parse_reads


def test_parse_reads_calculates_average_kw() -> None:
    readings = parse_reads(
        [
            {
                "timeInterval": "2026-07-17T12:00:00Z/2026-07-17T12:15:00Z",
                "measuredAmount": {"value": 0.177},
            }
        ]
    )

    assert len(readings) == 1
    assert readings[0].starts_at.tzinfo == UTC
    assert readings[0].kwh == 0.177
    assert readings[0].average_kw == 0.708


def test_parse_reads_skips_missing_measurements() -> None:
    readings = parse_reads(
        [
            {
                "timeInterval": "2026-07-17T12:00:00Z/2026-07-17T12:15:00Z",
                "measuredAmount": None,
            }
        ]
    )

    assert readings == []


async def test_client_reuses_authenticated_session(monkeypatch) -> None:
    client = ConEdClient("person@example.com", "password", "")
    authentication_count = 0

    async def authenticate(_client) -> None:
        nonlocal authentication_count
        authentication_count += 1

    async def select_account(_client) -> tuple[str, str, str]:
        return "account", "agreement", "point"

    async def get_register(_client, *_args) -> str:
        return "register"

    async def get_usage(_client, *_args) -> list[dict[str, object]]:
        return [
            {
                "timeInterval": "2026-07-17T12:00:00Z/2026-07-17T12:15:00Z",
                "measuredAmount": {"value": 0.177},
            }
        ]

    monkeypatch.setattr(client, "_authenticate", authenticate)
    monkeypatch.setattr(client, "_select_electric_account", select_account)
    monkeypatch.setattr(client, "_get_register", get_register)
    monkeypatch.setattr(client, "_get_usage", get_usage)

    try:
        await client.fetch_latest()
        await client.fetch_latest()
    finally:
        await client.close()

    assert authentication_count == 1


async def test_client_refreshes_expired_access_token_without_logging_in(monkeypatch) -> None:
    client = ConEdClient("person@example.com", "password", "")
    client._client = client._new_client()
    client._authenticated = True
    account_attempts = 0
    refresh_count = 0

    async def authenticate(_client) -> None:
        raise AssertionError("Access-token refresh must not perform a new credential login")

    async def select_account(_client) -> tuple[str, str, str]:
        nonlocal account_attempts
        account_attempts += 1
        if account_attempts == 1:
            request = httpx.Request("POST", "https://cned.opower.com/graphql")
            response = httpx.Response(401, request=request)
            raise httpx.HTTPStatusError("expired token", request=request, response=response)
        return "account", "agreement", "point"

    async def finish_authentication(_client, _redirect_url) -> None:
        nonlocal refresh_count
        refresh_count += 1

    async def get_register(_client, *_args) -> str:
        return "register"

    async def get_usage(_client, *_args) -> list[dict[str, object]]:
        return [
            {
                "timeInterval": "2026-07-17T12:00:00Z/2026-07-17T12:15:00Z",
                "measuredAmount": {"value": 0.177},
            }
        ]

    monkeypatch.setattr(client, "_authenticate", authenticate)
    monkeypatch.setattr(client, "_select_electric_account", select_account)
    monkeypatch.setattr(client, "_finish_authentication", finish_authentication)
    monkeypatch.setattr(client, "_get_register", get_register)
    monkeypatch.setattr(client, "_get_usage", get_usage)

    try:
        readings = await client.fetch_latest()
    finally:
        await client.close()

    assert len(readings) == 1
    assert account_attempts == 2
    assert refresh_count == 1


async def test_client_falls_back_to_recognized_device_login(monkeypatch) -> None:
    client = ConEdClient("person@example.com", "password", "")
    client._client = client._new_client()
    client._client.cookies.set("CE_DEVICE_ID", "remembered", domain=".www.coned.com")
    client._authenticated = True
    account_attempts = 0
    login_count = 0

    async def select_account(_client) -> tuple[str, str, str]:
        nonlocal account_attempts
        account_attempts += 1
        if account_attempts == 1:
            request = httpx.Request("POST", "https://cned.opower.com/graphql")
            response = httpx.Response(401, request=request)
            raise httpx.HTTPStatusError("expired token", request=request, response=response)
        return "account", "agreement", "point"

    async def finish_authentication(_client, _redirect_url) -> None:
        raise RuntimeError("empty Opower token")

    async def authenticate(auth_client) -> None:
        nonlocal login_count
        login_count += 1
        assert auth_client.cookies.get("CE_DEVICE_ID") == "remembered"

    async def get_register(_client, *_args) -> str:
        return "register"

    async def get_usage(_client, *_args) -> list[dict[str, object]]:
        return [
            {
                "timeInterval": "2026-07-17T12:00:00Z/2026-07-17T12:15:00Z",
                "measuredAmount": {"value": 0.177},
            }
        ]

    monkeypatch.setattr(client, "_select_electric_account", select_account)
    monkeypatch.setattr(client, "_finish_authentication", finish_authentication)
    monkeypatch.setattr(client, "_authenticate", authenticate)
    monkeypatch.setattr(client, "_get_register", get_register)
    monkeypatch.setattr(client, "_get_usage", get_usage)

    try:
        readings = await client.fetch_latest()
    finally:
        await client.close()

    assert len(readings) == 1
    assert account_attempts == 2
    assert login_count == 1


async def test_restore_preserves_device_cookies_when_token_is_expired(monkeypatch) -> None:
    original = ConEdClient("person@example.com", "password", "")
    original._client = original._new_client()
    original._client.cookies.set("CE_DEVICE_ID", "remembered", domain=".www.coned.com")
    original._authenticated = True
    snapshot = original.export_session()
    restored = ConEdClient("person@example.com", "password", "")

    async def finish_authentication(_client, _redirect_url) -> None:
        raise RuntimeError("empty Opower token")

    monkeypatch.setattr(restored, "_finish_authentication", finish_authentication)
    try:
        assert await restored.restore_session(snapshot)
        assert restored._client is not None
        assert restored._client.cookies.get("CE_DEVICE_ID") == "remembered"
        assert not restored._authenticated
    finally:
        await original.close()
        await restored.close()


async def test_client_exports_and_restores_session(monkeypatch) -> None:
    original = ConEdClient("person@example.com", "password", "")
    original._client = original._new_client()
    original._client.cookies.set("session", "opaque-value", domain=".coned.com", path="/")
    original._authenticated = True
    snapshot = original.export_session()

    restored = ConEdClient("person@example.com", "password", "")

    async def finish_authentication(_client, _redirect_url) -> None:
        return None

    monkeypatch.setattr(restored, "_finish_authentication", finish_authentication)
    try:
        assert await restored.restore_session(snapshot)
        assert restored._client is not None
        assert restored._client.cookies.get("session") == "opaque-value"
    finally:
        await original.close()
        await restored.close()


async def test_history_fetches_in_safe_month_chunks_and_deduplicates(monkeypatch) -> None:
    client = ConEdClient("person@example.com", "password", "")
    client._client = client._new_client()
    client._authenticated = True
    windows: list[tuple[datetime, datetime]] = []

    async def select_account(_client) -> tuple[str, str, str]:
        return "account", "agreement", "point"

    async def get_history(_client, *_args) -> list[dict[str, object]]:
        windows.append((_args[-2], _args[-1]))
        return [
            {
                "timeInterval": "2026-07-01T00:00:00Z/2026-07-01T01:00:00Z",
                "measuredAmount": {"value": 0.5},
            }
        ]

    monkeypatch.setattr(client, "_select_electric_account", select_account)
    monkeypatch.setattr(client, "_get_hourly_history", get_history)

    try:
        readings = await client.fetch_history(
            datetime(2026, 7, 17, 12, 45, tzinfo=UTC),
            days=91,
        )
    finally:
        await client.close()

    assert len(windows) == 4
    assert all((ends_at - starts_at).days <= 29 for starts_at, ends_at in windows)
    assert len(readings) == 1
    assert readings[0].kwh == 0.5
