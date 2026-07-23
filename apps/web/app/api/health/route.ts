import { getPool } from "@/lib/db";

export async function GET() {
  const pool = getPool();
  if (!pool) return Response.json({ ok: true, database: "demo-mode" });

  try {
    const result = await pool.query<{
      reading_count: number;
      latest_reading_at: Date | null;
      latest_fetch_at: Date | null;
      sources: string[];
    }>(`
      SELECT
        COUNT(*)::integer AS reading_count,
        MAX(ends_at) AS latest_reading_at,
        MAX(fetched_at) AS latest_fetch_at,
        COALESCE(ARRAY_AGG(DISTINCT source), ARRAY[]::text[]) AS sources
      FROM readings
    `);
    const data = result.rows[0];
    return Response.json({
      ok: true,
      database: "connected",
      dataMode: data.reading_count > 0 ? "live" : "demo",
      readingCount: data.reading_count,
      latestReadingAt: data.latest_reading_at?.toISOString() ?? null,
      latestFetchAt: data.latest_fetch_at?.toISOString() ?? null,
      sources: data.sources,
    });
  } catch {
    return Response.json({ ok: false, database: "unavailable" }, { status: 503 });
  }
}
