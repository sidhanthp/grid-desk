import {
  DASHBOARD_WEATHER_HOURS,
  buildWeatherUrl,
  parseWeatherPayload,
  resolveWeatherLocation,
  weatherCacheIsUsable,
  weatherCoversWindow,
  type OpenMeteoResponse,
  type WeatherPoint,
} from "@/lib/weather";

export const dynamic = "force-dynamic";

let weatherCache: { fetchedAtMs: number; points: WeatherPoint[] } | null = null;

function weatherResponse(points: WeatherPoint[]) {
  return Response.json(
    { source: "Open-Meteo", points },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET() {
  try {
    const nowMs = Date.now();
    if (weatherCache && weatherCacheIsUsable(weatherCache.points, weatherCache.fetchedAtMs, nowMs)) {
      return weatherResponse(weatherCache.points);
    }

    const response = await fetch(
      buildWeatherUrl(resolveWeatherLocation(process.env)),
      { cache: "no-store" },
    );
    if (!response.ok) throw new Error(`Open-Meteo returned ${response.status}`);
    const payload = (await response.json()) as OpenMeteoResponse;
    const points = parseWeatherPayload(payload);
    if (!weatherCoversWindow(points, new Date(nowMs).toISOString(), DASHBOARD_WEATHER_HOURS)) {
      throw new Error("Open-Meteo returned an incomplete rolling weather window");
    }
    weatherCache = { fetchedAtMs: nowMs, points };

    return weatherResponse(points);
  } catch (error) {
    console.error("Unable to load weather", error);
    return Response.json({ source: "unavailable", points: [] }, { status: 503 });
  }
}
