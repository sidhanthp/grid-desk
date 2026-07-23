import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const pool = getPool();
  if (!pool) return Response.json({ ready: false, reason: "database-not-configured" }, { status: 503 });

  try {
    const result = await pool.query<{
      reading_count: number;
      latest_reading_at: Date | null;
      latest_fetch_at: Date | null;
    }>(`
      SELECT
        COUNT(*)::integer AS reading_count,
        MAX(ends_at) AS latest_reading_at,
        MAX(fetched_at) AS latest_fetch_at
      FROM readings
    `);
    const data = result.rows[0];
    const latestAgeMs = data.latest_reading_at
      ? Date.now() - data.latest_reading_at.getTime()
      : Number.POSITIVE_INFINITY;
    const ready = data.reading_count > 0 && latestAgeMs < 3 * 60 * 60 * 1000;
    return Response.json(
      {
        ready,
        readingCount: data.reading_count,
        latestReadingAt: data.latest_reading_at?.toISOString() ?? null,
        latestFetchAt: data.latest_fetch_at?.toISOString() ?? null,
      },
      { status: ready ? 200 : 503 },
    );
  } catch {
    return Response.json({ ready: false, reason: "database-unavailable" }, { status: 503 });
  }
}
