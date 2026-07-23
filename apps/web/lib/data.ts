import { getPool } from "./db";
import type { DashboardSnapshot, Reading } from "./types";

const QUARTER_HOUR = 15 * 60 * 1000;
const DEMO_INTERVALS = 8 * 24 * 4;
const NEW_YORK_TIME = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "America/New_York",
});

function newYorkParts(value: Date) {
  return Object.fromEntries(
    NEW_YORK_TIME.formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<"year" | "month" | "day" | "hour" | "minute", number>;
}

function newYorkDateKey(value: Date) {
  const parts = newYorkParts(value);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function demoReadings(): Reading[] {
  const end = new Date();
  end.setMinutes(Math.floor(end.getMinutes() / 15) * 15 - 45, 0, 0);

  return Array.from({ length: DEMO_INTERVALS }, (_, index) => {
    const startsAt = new Date(end.getTime() - (DEMO_INTERVALS - 1 - index) * QUARTER_HOUR);
    const hour = startsAt.getHours() + startsAt.getMinutes() / 60;
    const morning = Math.exp(-Math.pow((hour - 8.2) / 1.7, 2)) * 0.62;
    const evening = Math.exp(-Math.pow((hour - 19.1) / 2.3, 2)) * 1.35;
    const dailyVariation = 0.86 + 0.18 * Math.sin((index / 96) * Math.PI * 0.7);
    const baseline = 0.22 + 0.05 * Math.sin(index * 1.7) + 0.025 * Math.sin(index * 4.2);
    const averageKw = Math.max(0.12, (baseline + morning + evening) * dailyVariation);
    return {
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + QUARTER_HOUR).toISOString(),
      averageKw: Number(averageKw.toFixed(3)),
      kwh: Number((averageKw / 4).toFixed(4)),
    };
  });
}

function summarize(readings: Reading[], mode: "live" | "demo", lastSyncedAt?: string): DashboardSnapshot {
  const latest = readings.at(-1)!;
  const today = new Date();
  const todayParts = newYorkParts(today);
  const todayKey = newYorkDateKey(today);
  const todayKwh = readings
    .filter((reading) => newYorkDateKey(new Date(reading.startsAt)) === todayKey)
    .reduce((sum, reading) => sum + reading.kwh, 0);

  const elapsedHours = Math.max(todayParts.hour + todayParts.minute / 60, 1);
  const dailyProjection = (todayKwh / elapsedHours) * 24;
  const daysInMonth = new Date(todayParts.year, todayParts.month, 0).getDate();
  const quietest = readings.reduce((best, reading) =>
    reading.averageKw < best.averageKw ? reading : best,
  );

  return {
    mode,
    readings,
    latestReadingAt: latest.endsAt,
    lastSyncedAt: lastSyncedAt ?? new Date().toISOString(),
    currentKw: latest.averageKw,
    todayKwh: Number(todayKwh.toFixed(2)),
    projectedMonthKwh: Math.round(dailyProjection * daysInMonth),
    quietestWindow: new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(
      new Date(quietest.startsAt),
    ),
  };
}

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  const pool = getPool();
  if (!pool) return summarize(demoReadings(), "demo");

  const result = await pool.query<{
    starts_at: Date;
    ends_at: Date;
    kwh: string;
    average_kw: string;
    fetched_at: Date;
  }>(`
    SELECT starts_at, ends_at, kwh, average_kw, fetched_at
    FROM readings
    WHERE meter_key = $1
      AND starts_at >= NOW() - INTERVAL '8 days'
    ORDER BY starts_at ASC
  `, [process.env.METER_KEY ?? "home"]);

  if (!result.rows.length) return summarize(demoReadings(), "demo");

  const readings = result.rows.map((row) => ({
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    kwh: Number(row.kwh),
    averageKw: Number(row.average_kw),
  }));

  return summarize(readings, "live", result.rows.at(-1)!.fetched_at.toISOString());
}
