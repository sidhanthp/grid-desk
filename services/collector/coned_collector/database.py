from pathlib import Path
from datetime import datetime
from typing import Iterable

import asyncpg

from .coned import IntervalReading


SCHEMA = (Path(__file__).parent / "schema.sql").read_text()


class Database:
    def __init__(self, database_url: str) -> None:
        self.database_url = database_url
        self.pool: asyncpg.Pool | None = None

    async def connect(self) -> None:
        self.pool = await asyncpg.create_pool(self.database_url, min_size=1, max_size=4)
        async with self.pool.acquire() as connection:
            await connection.execute(SCHEMA)

    async def close(self) -> None:
        if self.pool:
            await self.pool.close()

    async def start_sync(self) -> int:
        assert self.pool
        return await self.pool.fetchval("INSERT INTO sync_runs DEFAULT VALUES RETURNING id")

    async def finish_sync(self, sync_id: int, readings_received: int) -> None:
        assert self.pool
        await self.pool.execute(
            """
            UPDATE sync_runs
            SET finished_at = NOW(), status = 'succeeded', readings_received = $2
            WHERE id = $1
            """,
            sync_id,
            readings_received,
        )

    async def fail_sync(self, sync_id: int, error: str) -> None:
        assert self.pool
        await self.pool.execute(
            """
            UPDATE sync_runs
            SET finished_at = NOW(), status = 'failed', error = $2
            WHERE id = $1
            """,
            sync_id,
            error[:2000],
        )

    async def upsert_readings(
        self,
        meter_key: str,
        readings: Iterable[IntervalReading],
        source: str = "coned-opower",
    ) -> int:
        assert self.pool
        rows = list(readings)
        async with self.pool.acquire() as connection, connection.transaction():
            await connection.executemany(
                """
                INSERT INTO readings (
                    meter_key, starts_at, ends_at, kwh, average_kw, source, fetched_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, NOW())
                ON CONFLICT (meter_key, starts_at) DO UPDATE
                SET ends_at = EXCLUDED.ends_at,
                    kwh = EXCLUDED.kwh,
                    average_kw = EXCLUDED.average_kw,
                    source = EXCLUDED.source,
                    fetched_at = NOW()
                """,
                [
                    (meter_key, row.starts_at, row.ends_at, row.kwh, row.average_kw, source)
                    for row in rows
                ],
            )
        return len(rows)

    async def ingestion_status(self) -> dict[str, object]:
        assert self.pool
        row = await self.pool.fetchrow(
            """
            SELECT
                COUNT(*)::integer AS reading_count,
                MAX(ends_at) AS latest_reading_at,
                MAX(fetched_at) AS latest_fetch_at,
                COALESCE(ARRAY_AGG(DISTINCT source), ARRAY[]::text[]) AS sources
            FROM readings
            """
        )
        sync = await self.pool.fetchrow(
            """
            SELECT finished_at, readings_received
            FROM sync_runs
            WHERE status = 'succeeded' AND readings_received > 0
            ORDER BY finished_at DESC
            LIMIT 1
            """
        )
        return {
            "reading_count": row["reading_count"],
            "latest_reading_at": row["latest_reading_at"],
            "latest_fetch_at": row["latest_fetch_at"],
            "sources": row["sources"],
            "collector_sync_at": sync["finished_at"] if sync else None,
            "collector_readings_received": sync["readings_received"] if sync else 0,
        }

    async def earliest_reading_at(self, meter_key: str) -> datetime | None:
        assert self.pool
        return await self.pool.fetchval(
            "SELECT MIN(starts_at) FROM readings WHERE meter_key = $1",
            meter_key,
        )

    async def get_state(self, key: str) -> str | None:
        assert self.pool
        return await self.pool.fetchval(
            "SELECT value FROM collector_state WHERE key = $1",
            key,
        )

    async def set_state(self, key: str, value: str) -> None:
        assert self.pool
        await self.pool.execute(
            """
            INSERT INTO collector_state (key, value)
            VALUES ($1, $2)
            ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, updated_at = NOW()
            """,
            key,
            value,
        )

    async def delete_state(self, key: str) -> None:
        assert self.pool
        await self.pool.execute("DELETE FROM collector_state WHERE key = $1", key)

    async def health(self) -> bool:
        if not self.pool:
            return False
        return (await self.pool.fetchval("SELECT 1")) == 1
