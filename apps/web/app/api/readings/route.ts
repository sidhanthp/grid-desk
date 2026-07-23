import { getDashboardSnapshot } from "@/lib/data";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const snapshot = await getDashboardSnapshot();
    return Response.json(snapshot, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("Unable to load readings", error);
    return Response.json({ error: "Readings are temporarily unavailable." }, { status: 503 });
  }
}
