import assert from "node:assert/strict";
import test from "node:test";

import {
  DASHBOARD_WEATHER_HOURS,
  WEATHER_FORECAST_HOURS,
  WEATHER_HISTORY_HOURS,
  buildWeatherUrl,
  parseWeatherPayload,
  resolveWeatherLocation,
  weatherCacheIsUsable,
  weatherCoversWindow,
} from "./weather.ts";

const HOUR_MS = 3_600_000;

function hourlyPoints(firstAt, count) {
  const firstMs = Date.parse(firstAt);
  return Array.from({ length: count }, (_, index) => ({
    at: new Date(firstMs + index * HOUR_MS).toISOString(),
    temperatureF: 70 + index / 10,
    apparentF: 70 + index / 10,
  }));
}

test("weather request uses a rolling hourly window instead of UTC calendar days", () => {
  const url = buildWeatherUrl();
  assert.equal(url.searchParams.get("past_hours"), String(WEATHER_HISTORY_HOURS));
  assert.equal(url.searchParams.get("forecast_hours"), String(WEATHER_FORECAST_HOURS));
  assert.equal(url.searchParams.has("past_days"), false);
  assert.equal(url.searchParams.has("forecast_days"), false);
});

test("weather location is configurable without embedding a residence", () => {
  const location = resolveWeatherLocation({
    WEATHER_LATITUDE: "51.5072",
    WEATHER_LONGITUDE: "-0.1276",
  });
  const url = buildWeatherUrl(location);
  assert.equal(url.searchParams.get("latitude"), "51.5072");
  assert.equal(url.searchParams.get("longitude"), "-0.1276");
  assert.throws(
    () => resolveWeatherLocation({ WEATHER_LATITUDE: "91" }),
    /valid latitude and longitude/,
  );
});

test("previous-day response ending at 7 PM does not cover the meter window", () => {
  const stale = hourlyPoints("2026-07-12T00:00:00.000Z", 168);
  assert.equal(stale.at(-1).at, "2026-07-18T23:00:00.000Z");
  assert.equal(
    weatherCoversWindow(stale, "2026-07-19T10:00:00.000Z", DASHBOARD_WEATHER_HOURS),
    false,
  );
});

test("complete hourly series covers the seven-day meter window", () => {
  const complete = hourlyPoints("2026-07-12T10:00:00.000Z", DASHBOARD_WEATHER_HOURS + 1);
  assert.equal(
    weatherCoversWindow(complete, "2026-07-19T10:00:00.000Z", DASHBOARD_WEATHER_HOURS),
    true,
  );
});

test("a missing hour makes an otherwise current response incomplete", () => {
  const complete = hourlyPoints("2026-07-12T10:00:00.000Z", DASHBOARD_WEATHER_HOURS + 1);
  const missingHour = complete.filter((_, index) => index !== 80);
  assert.equal(
    weatherCoversWindow(missingHour, "2026-07-19T10:00:00.000Z", DASHBOARD_WEATHER_HOURS),
    false,
  );
});

test("weather payload parser skips null temperatures and preserves apparent temperature", () => {
  const points = parseWeatherPayload({
    hourly: {
      time: ["2026-07-19T09:00", "2026-07-19T10:00"],
      temperature_2m: [71.2, null],
      apparent_temperature: [72.4, 73.1],
    },
  });
  assert.deepEqual(points, [{
    at: "2026-07-19T09:00:00.000Z",
    temperatureF: 71.2,
    apparentF: 72.4,
  }]);
});

test("server cache is reused only while both fresh and complete", () => {
  const now = Date.parse("2026-07-19T10:05:00.000Z");
  const complete = hourlyPoints("2026-07-12T10:00:00.000Z", DASHBOARD_WEATHER_HOURS + 2);
  const incomplete = complete.slice(0, -2);

  assert.equal(weatherCacheIsUsable(complete, now - 60_000, now), true);
  assert.equal(weatherCacheIsUsable(complete, now - 10 * 60_000, now), false);
  assert.equal(weatherCacheIsUsable(incomplete, now - 60_000, now), false);
});
