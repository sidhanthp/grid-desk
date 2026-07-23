const HOUR_MS = 3_600_000;

export const WEATHER_HISTORY_HOURS = 24 * 8;
export const WEATHER_FORECAST_HOURS = 24;
export const DASHBOARD_WEATHER_HOURS = 24 * 7;
export const WEATHER_CACHE_TTL_MS = 5 * 60 * 1000;

export type WeatherPoint = {
  at: string;
  temperatureF: number;
  apparentF: number;
};

export type OpenMeteoResponse = {
  hourly?: {
    time?: string[];
    temperature_2m?: Array<number | null>;
    apparent_temperature?: Array<number | null>;
  };
};

export type WeatherLocation = {
  latitude: number;
  longitude: number;
};

// A city-level default keeps demo mode useful without identifying a residence.
export const DEFAULT_WEATHER_LOCATION: WeatherLocation = {
  latitude: 40.7128,
  longitude: -74.006,
};

function coordinate(value: string | undefined, fallback: number, min: number, max: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error("Weather coordinates must be valid latitude and longitude values");
  }
  return parsed;
}

export function resolveWeatherLocation(
  environment: Record<string, string | undefined> = {},
): WeatherLocation {
  return {
    latitude: coordinate(
      environment.WEATHER_LATITUDE,
      DEFAULT_WEATHER_LOCATION.latitude,
      -90,
      90,
    ),
    longitude: coordinate(
      environment.WEATHER_LONGITUDE,
      DEFAULT_WEATHER_LOCATION.longitude,
      -180,
      180,
    ),
  };
}

export function buildWeatherUrl(location = DEFAULT_WEATHER_LOCATION) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    hourly: "temperature_2m,apparent_temperature",
    temperature_unit: "fahrenheit",
    timezone: "GMT",
    past_hours: String(WEATHER_HISTORY_HOURS),
    forecast_hours: String(WEATHER_FORECAST_HOURS),
  }).toString();
  return url;
}

export function parseWeatherPayload(payload: OpenMeteoResponse): WeatherPoint[] {
  const times = payload.hourly?.time ?? [];
  const temperatures = payload.hourly?.temperature_2m ?? [];
  const apparent = payload.hourly?.apparent_temperature ?? [];

  return times.flatMap((time, index) => {
    const temperatureF = temperatures[index];
    if (temperatureF == null) return [];
    return [{
      at: new Date(`${time}Z`).toISOString(),
      temperatureF,
      apparentF: apparent[index] ?? temperatureF,
    }];
  });
}

export function weatherCoversWindow(
  points: WeatherPoint[],
  windowEndsAt: string,
  windowHours = DASHBOARD_WEATHER_HOURS,
) {
  const endMs = new Date(windowEndsAt).getTime();
  if (!Number.isFinite(endMs) || !points.length) return false;

  const endHour = Math.floor(endMs / HOUR_MS) * HOUR_MS;
  const startHour = endHour - windowHours * HOUR_MS;
  const timestamps = [...new Set(
    points
      .map((point) => new Date(point.at).getTime())
      .filter(Number.isFinite),
  )].sort((left, right) => left - right);

  if (!timestamps.length || timestamps[0] > startHour || timestamps.at(-1)! < endHour) {
    return false;
  }

  const relevant = timestamps.filter((timestamp) => timestamp >= startHour && timestamp <= endHour);
  return relevant.length >= windowHours + 1
    && relevant.every((timestamp, index) => index === 0 || timestamp - relevant[index - 1] <= HOUR_MS);
}

export function weatherCacheIsUsable(
  points: WeatherPoint[],
  fetchedAtMs: number,
  nowMs: number,
) {
  return nowMs - fetchedAtMs >= 0
    && nowMs - fetchedAtMs < WEATHER_CACHE_TTL_MS
    && weatherCoversWindow(points, new Date(nowMs).toISOString());
}
