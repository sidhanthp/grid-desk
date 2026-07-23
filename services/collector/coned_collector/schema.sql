CREATE TABLE IF NOT EXISTS readings (
    meter_key TEXT NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    kwh NUMERIC(12, 6) NOT NULL CHECK (kwh >= 0),
    average_kw NUMERIC(12, 6) NOT NULL CHECK (average_kw >= 0),
    source TEXT NOT NULL DEFAULT 'coned-opower',
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (meter_key, starts_at)
);
CREATE INDEX IF NOT EXISTS readings_recent_idx
    ON readings (meter_key, starts_at DESC);

CREATE TABLE IF NOT EXISTS sync_runs (
    id BIGSERIAL PRIMARY KEY,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'running',
    readings_received INTEGER NOT NULL DEFAULT 0,
    error TEXT
);

CREATE TABLE IF NOT EXISTS collector_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
