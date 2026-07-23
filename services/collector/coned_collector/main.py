import asyncio
import logging
import secrets
from contextlib import asynccontextmanager, suppress
from datetime import UTC, datetime, timedelta

from cryptography.fernet import Fernet, InvalidToken
from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .coned import ConEdClient, MFARequiredError
from .config import settings
from .database import Database


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logger = logging.getLogger("coned-collector")

database = Database(settings.database_url) if settings.database_url else None
coned_client = (
    ConEdClient(
        email=settings.coned_email,
        password=settings.coned_password.get_secret_value(),
        totp_secret=settings.coned_totp_secret.get_secret_value(),
        account_urn=settings.coned_account_urn,
    )
    if settings.ingestion_configured
    else None
)
collector_task: asyncio.Task[None] | None = None
collector_resume = asyncio.Event()
last_success_at: datetime | None = None
last_error: str | None = None
SESSION_STATE_KEY = "coned-session-v1"
MIN_READY_WINDOW = timedelta(minutes=15)


def build_session_cipher() -> Fernet | None:
    key = settings.session_encryption_key.get_secret_value()
    if not key:
        return None
    try:
        return Fernet(key.encode())
    except ValueError:
        logger.error("SESSION_ENCRYPTION_KEY is not a valid Fernet key")
        return None


session_cipher = build_session_cipher()


async def persist_coned_session() -> None:
    if not database or not coned_client or not session_cipher:
        return
    try:
        encrypted = session_cipher.encrypt(coned_client.export_session().encode()).decode()
        await database.set_state(SESSION_STATE_KEY, encrypted)
    except Exception:
        logger.exception("Unable to persist the encrypted Con Edison session")


async def restore_coned_session() -> bool:
    if not database or not coned_client or not session_cipher:
        return False
    encrypted = await database.get_state(SESSION_STATE_KEY)
    if not encrypted:
        return False
    try:
        snapshot = session_cipher.decrypt(encrypted.encode()).decode()
    except (InvalidToken, UnicodeDecodeError):
        logger.warning("Discarding an unreadable persisted Con Edison session")
        await database.delete_state(SESSION_STATE_KEY)
        return False
    restored = await coned_client.restore_session(snapshot)
    if not restored:
        logger.info("Persisted Con Edison session expired; a new login is required")
        await database.delete_state(SESSION_STATE_KEY)
        return False
    logger.info("Restored the persisted Con Edison session")
    return True


def collector_freshness(
    collector_sync_at: object,
    error: str | None,
    now: datetime | None = None,
) -> tuple[bool, int | None, int]:
    max_age = max(MIN_READY_WINDOW, timedelta(seconds=settings.poll_seconds * 3))
    max_age_seconds = int(max_age.total_seconds())
    if not isinstance(collector_sync_at, datetime):
        return False, None, max_age_seconds
    sync_age_seconds = max(0, int(((now or datetime.now(UTC)) - collector_sync_at).total_seconds()))
    return error is None and sync_age_seconds <= max_age_seconds, sync_age_seconds, max_age_seconds


class MFAPayload(BaseModel):
    code: str = Field(pattern=r"^\d{6}$")


async def collect_once() -> int:
    global last_success_at, last_error
    if not database or not coned_client:
        raise RuntimeError("Collector credentials or DATABASE_URL are not configured")

    sync_id = await database.start_sync()
    try:
        readings = await coned_client.fetch_latest()
        count = await database.upsert_readings(
            settings.meter_key,
            readings,
            source="server-login",
        )
        await database.finish_sync(sync_id, count)
        await persist_coned_session()
        last_success_at = datetime.now(UTC)
        last_error = None
        logger.info("Stored %s Con Edison interval readings", count)
        return count
    except Exception as error:
        last_error = type(error).__name__
        await database.fail_sync(sync_id, f"{type(error).__name__}: {error}")
        logger.exception("Con Edison sync failed")
        raise


async def backfill_history() -> int:
    if not database or not coned_client:
        raise RuntimeError("Collector credentials or DATABASE_URL are not configured")
    earliest = await database.earliest_reading_at(settings.meter_key)
    if not isinstance(earliest, datetime):
        return 0

    sync_id = await database.start_sync()
    try:
        readings = await coned_client.fetch_history(earliest, days=730)
        count = await database.upsert_readings(
            settings.meter_key,
            readings,
            source="server-history-hourly",
        )
        await database.finish_sync(sync_id, count)
        logger.info("Backfilled %s hourly Con Edison readings", count)
        return count
    except Exception as error:
        await database.fail_sync(sync_id, f"{type(error).__name__}: {error}")
        logger.exception("Con Edison history backfill failed")
        raise


async def collector_loop() -> None:
    while True:
        try:
            await collect_once()
        except MFARequiredError:
            logger.warning("Con Edison MFA required; automatic polling paused")
            await collector_resume.wait()
            collector_resume.clear()
            continue
        except Exception:
            pass
        await asyncio.sleep(settings.poll_seconds)


@asynccontextmanager
async def lifespan(_: FastAPI):
    global collector_task
    if database:
        await database.connect()
    if settings.ingestion_configured:
        await restore_coned_session()
        collector_task = asyncio.create_task(collector_loop())
    else:
        logger.warning("Collector started in unconfigured mode; health endpoint remains available")
    yield
    if collector_task:
        collector_task.cancel()
        with suppress(asyncio.CancelledError):
            await collector_task
    if database:
        await database.close()
    if coned_client:
        await coned_client.close()


app = FastAPI(
    title="Con Edison Collector",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
)


@app.middleware("http")
async def security_headers(request: Request, call_next) -> Response:
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    return response


def require_bearer_token(authorization: str | None) -> None:
    expected_token = settings.ingest_token.get_secret_value()
    scheme, separator, supplied_token = (authorization or "").partition(" ")
    if (
        not expected_token
        or not separator
        or scheme.lower() != "bearer"
        or not secrets.compare_digest(expected_token, supplied_token)
    ):
        raise HTTPException(status_code=401, detail="invalid bearer token")


@app.get("/health")
async def health() -> dict[str, object]:
    database_ok = await database.health() if database else False
    return {
        "ok": database_ok,
        "configured": settings.ingestion_configured,
        "auth_mode": "server-login" if settings.ingestion_configured else "unconfigured",
        "database": database_ok,
        "last_success_at": last_success_at,
        "last_error": last_error,
    }


@app.get("/ready")
async def ready() -> JSONResponse:
    database_ok = await database.health() if database else False
    status = await database.ingestion_status() if database_ok and database else {}
    collector_fresh, sync_age_seconds, max_sync_age_seconds = collector_freshness(
        status.get("collector_sync_at"),
        last_error,
    )
    auth_configured = settings.ingestion_configured
    payload = {
        "ready": database_ok and auth_configured and collector_fresh,
        "configured": auth_configured,
        "auth_mode": "server-login" if settings.ingestion_configured else "unconfigured",
        "database": database_ok,
        "collector_fresh": collector_fresh,
        "sync_age_seconds": sync_age_seconds,
        "max_sync_age_seconds": max_sync_age_seconds,
        **status,
        "last_error": last_error,
    }
    return JSONResponse(jsonable_encoder(payload), status_code=200 if payload["ready"] else 503)


@app.post("/auth/mfa")
async def submit_mfa(
    payload: MFAPayload,
    authorization: str | None = Header(default=None),
) -> dict[str, object]:
    require_bearer_token(authorization)
    if not coned_client:
        raise HTTPException(status_code=503, detail="server login is not configured")

    try:
        await coned_client.submit_mfa(payload.code)
        stored = await collect_once()
        backfilled = await backfill_history()
        collector_resume.set()
        return {"ok": True, "stored": stored, "backfilled": backfilled}
    except RuntimeError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
