"use client";

import { useEffect, useMemo, useState } from "react";
import type { DashboardSnapshot, Reading } from "@/lib/types";
import {
  DASHBOARD_WEATHER_HOURS,
  weatherCoversWindow,
  type WeatherPoint,
} from "@/lib/weather";
import styles from "./ElectricityDashboard.module.css";

type RangeKey = "3h" | "24h" | "7d";

const HOURS_PER_BILLING_MONTH = 24 * 365.25 / 12;
const RANGE_HOURS: Record<RangeKey, number> = { "3h": 3, "24h": 24, "7d": 168 };

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  }).format(new Date(value));
}

function formatDay(value: string, weekday: "short" | "long" = "short") {
  return new Intl.DateTimeFormat("en-US", {
    weekday,
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  }).format(new Date(value));
}

function formatAxisLabel(value: number, range: RangeKey) {
  const date = new Date(value);
  if (range === "7d") {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "numeric",
      day: "numeric",
      timeZone: "America/New_York",
    }).format(date);
  }
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: range === "3h" ? "2-digit" : undefined,
    timeZone: "America/New_York",
  }).format(date);
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function estimateCost(
  kwh: number,
  coveredHours: number,
  ratePerKwh: number,
  monthlyFixedCharge: number,
) {
  return kwh * ratePerKwh
    + (coveredHours / HOURS_PER_BILLING_MONTH) * monthlyFixedCharge;
}

function selectRange(readings: Reading[], range: RangeKey) {
  if (!readings.length) return [];
  const latest = new Date(readings.at(-1)!.endsAt).getTime();
  const cutoff = latest - RANGE_HOURS[range] * 60 * 60 * 1000;
  return readings.filter((reading) => new Date(reading.endsAt).getTime() > cutoff);
}

function groupDays(readings: Reading[], weather: WeatherPoint[]) {
  const dayKey = (value: string) => new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "America/New_York",
  }).format(new Date(value));
  const grouped = new Map<string, { readings: Reading[]; temperatures: number[]; hours: number }>();
  for (const reading of readings) {
    const key = dayKey(reading.startsAt);
    const entry = grouped.get(key) ?? { readings: [], temperatures: [], hours: 0 };
    entry.readings.push(reading);
    entry.hours += Math.max(
      0,
      (new Date(reading.endsAt).getTime() - new Date(reading.startsAt).getTime()) / 3_600_000,
    );
    grouped.set(key, entry);
  }
  for (const point of weather) {
    const entry = grouped.get(dayKey(point.at));
    if (entry) entry.temperatures.push(point.temperatureF);
  }
  return [...grouped.entries()].map(([key, value]) => ({
    key,
    label: formatDay(value.readings[0].startsAt, "short"),
    kwh: value.readings.reduce((sum, reading) => sum + reading.kwh, 0),
    averageF: value.temperatures.length
      ? value.temperatures.reduce((sum, temperature) => sum + temperature, 0) / value.temperatures.length
      : null,
    peakKw: value.readings.reduce((highest, reading) => Math.max(highest, reading.averageKw), 0),
    intervals: value.readings.length,
    hours: value.hours,
    complete: value.hours >= 22,
  }));
}

function RangePicker({ value, onChange }: { value: RangeKey; onChange: (range: RangeKey) => void }) {
  return (
    <div className={styles.rangePicker} role="tablist" aria-label="Chart range">
      {(["3h", "24h", "7d"] as RangeKey[]).map((range) => (
        <button
          key={range}
          type="button"
          role="tab"
          aria-selected={value === range}
          className={value === range ? styles.activeRange : ""}
          onClick={() => onChange(range)}
        >
          {range === "7d" ? "7 days" : range === "24h" ? "24 hours" : "3 hours"}
        </button>
      ))}
    </div>
  );
}

function EnergyChart({
  readings,
  weather,
  range,
}: {
  readings: Reading[];
  weather: WeatherPoint[];
  range: RangeKey;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const visible = readings;
  const values = visible.map((reading) => reading.averageKw);
  const ceiling = Math.max(0.5, Math.ceil(Math.max(...values, 0.5) * 2) / 2);
  const plot = { left: 70, right: 930, top: 15, bottom: 252 };
  const plotWidth = plot.right - plot.left;
  const plotHeight = plot.bottom - plot.top;
  const domainEnd = visible.length ? new Date(visible.at(-1)!.endsAt).getTime() : Date.now();
  const domainStart = domainEnd - RANGE_HOURS[range] * 3_600_000;
  const domainSpan = Math.max(domainEnd - domainStart, 1);
  const xForTime = (value: number) => plot.left
    + Math.min(1, Math.max(0, (value - domainStart) / domainSpan)) * plotWidth;
  const weatherVisible = weather;
  const temperatures = weatherVisible.map((point) => point.temperatureF);
  const weatherFloor = temperatures.length ? Math.floor(Math.min(...temperatures) / 5) * 5 : 60;
  const weatherCeiling = temperatures.length ? Math.ceil(Math.max(...temperatures) / 5) * 5 : 90;
  const weatherSpan = Math.max(weatherCeiling - weatherFloor, 5);
  const weatherPath = weatherVisible.map((point, index) => {
    const x = xForTime(new Date(point.at).getTime());
    const value = point.temperatureF;
    const y = plot.bottom - ((value - weatherFloor) / weatherSpan) * plotHeight;
    return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => domainStart + ratio * domainSpan);
  const hovered = hoverIndex == null ? null : visible[hoverIndex];
  const hoveredX = hovered
    ? xForTime((new Date(hovered.startsAt).getTime() + new Date(hovered.endsAt).getTime()) / 2)
    : null;

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!visible.length) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const plotLeft = bounds.left + bounds.width * (plot.left / 1000);
    const plotRight = bounds.left + bounds.width * (plot.right / 1000);
    const ratio = Math.min(1, Math.max(0, (event.clientX - plotLeft) / (plotRight - plotLeft)));
    const targetTime = domainStart + ratio * domainSpan;
    const nearest = visible.reduce((best, reading, index) => {
      const midpoint = (new Date(reading.startsAt).getTime() + new Date(reading.endsAt).getTime()) / 2;
      const distance = Math.abs(midpoint - targetTime);
      return distance < best.distance ? { index, distance } : best;
    }, { index: 0, distance: Number.POSITIVE_INFINITY });
    setHoverIndex(nearest.index);
  }

  return (
    <div
      className={styles.chartFrame}
      role="img"
      aria-label={`Electricity demand chart. X axis is local ${range === "7d" ? "date" : "time"}, left Y axis is kilowatts, and right Y axis is outdoor temperature in Fahrenheit.`}
      onPointerMove={handlePointerMove}
      onPointerDown={handlePointerMove}
      onPointerLeave={() => setHoverIndex(null)}
    >
      <svg viewBox="0 0 1000 300" preserveAspectRatio="none" className={styles.chartSvg}>
        <g className={styles.chartGrid}>
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const y = plot.bottom - ratio * plotHeight;
            return <line key={ratio} x1={plot.left} x2={plot.right} y1={y} y2={y} />;
          })}
          {xTicks.map((timestamp) => {
            const x = xForTime(timestamp);
            return <line key={timestamp} x1={x} x2={x} y1={plot.top} y2={plot.bottom} />;
          })}
        </g>
        <g className={styles.axisLabels} aria-hidden="true">
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const y = plot.bottom - ratio * plotHeight;
            return <text key={`kw-${ratio}`} x={plot.left - 12} y={y + 4} textAnchor="end">{(ceiling * ratio).toFixed(1)}</text>;
          })}
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const y = plot.bottom - ratio * plotHeight;
            return <text key={`temp-${ratio}`} x={plot.right + 12} y={y + 4}>{Math.round(weatherFloor + weatherSpan * ratio)}°</text>;
          })}
          {xTicks.map((timestamp, tick) => {
            const x = xForTime(timestamp);
            return <text key={`time-${timestamp}`} x={x} y="274" textAnchor={tick === 0 ? "start" : tick === xTicks.length - 1 ? "end" : "middle"}>{formatAxisLabel(timestamp, range)}</text>;
          })}
          <text className={styles.axisTitle} x="16" y="134" transform="rotate(-90 16 134)" textAnchor="middle">DEMAND · kW</text>
          <text className={styles.axisTitle} x="984" y="134" transform="rotate(90 984 134)" textAnchor="middle">OUTSIDE · °F</text>
          <text className={styles.axisTitle} x="500" y="296" textAnchor="middle">LOCAL {range === "7d" ? "DATE" : "TIME"}</text>
        </g>
        {visible.map((reading) => {
          const height = (reading.averageKw / ceiling) * plotHeight;
          const x = xForTime(new Date(reading.startsAt).getTime());
          const endX = xForTime(new Date(reading.endsAt).getTime());
          const barWidth = Math.max(1.5, endX - x - 0.8);
          return <rect key={reading.startsAt} x={x} y={plot.bottom - height} width={barWidth} height={height} className={styles.energyBar} />;
        })}
        {weatherPath && <path d={weatherPath} className={styles.weatherLine} />}
        {hoveredX != null && (
          <line
            className={styles.hoverRule}
            x1={hoveredX}
            x2={hoveredX}
            y1={plot.top}
            y2={plot.bottom}
          />
        )}
      </svg>
      {hovered && hoveredX != null && (
        <div className={styles.chartTooltip} style={{ left: `${Math.min(91, Math.max(9, hoveredX / 10))}%` }}>
          <strong>{hovered.averageKw.toFixed(3)} kW</strong>
          <span>{hovered.kwh.toFixed(3)} kWh · {range === "7d" ? `${formatDay(hovered.endsAt)} · ` : ""}{formatTime(hovered.endsAt)}</span>
        </div>
      )}
    </div>
  );
}

function AppHeader({
  lagMinutes,
  collectorStale,
  mode,
}: {
  lagMinutes: number;
  collectorStale: boolean;
  mode: DashboardSnapshot["mode"];
}) {
  const status = mode === "demo"
    ? "Demo feed · sample data"
    : `${collectorStale ? "Feed interrupted" : "Live feed"} · ${lagMinutes}m delay`;
  return (
    <header className={styles.previewNav}>
      <div className={styles.homeLink} aria-label="Grid Desk electricity dashboard">
        <img className={styles.homeMark} src="/icon.svg" alt="" width="32" height="32" />
        <span>Grid Desk</span>
      </div>
      <p className={`${styles.liveStatus} ${collectorStale ? styles.staleStatus : ""}`}>
        <i /> {status}
      </p>
    </header>
  );
}

export function ElectricityDashboard({
  initialSnapshot,
  ratePerKwh,
  monthlyFixedCharge,
}: {
  initialSnapshot: DashboardSnapshot;
  ratePerKwh: number;
  monthlyFixedCharge: number;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [range, setRange] = useState<RangeKey>("24h");
  const [weather, setWeather] = useState<WeatherPoint[]>([]);

  useEffect(() => {
    let active = true;
    let latestReadingAt = initialSnapshot.latestReadingAt;

    async function fetchWeather() {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const suffix = attempt ? `?retry=${Date.now()}` : "";
          const response = await fetch(`/api/weather${suffix}`, { cache: "no-store" });
          if (!response.ok) continue;
          const points = ((await response.json()).points ?? []) as WeatherPoint[];
          if (weatherCoversWindow(points, latestReadingAt, DASHBOARD_WEATHER_HOURS)) {
            return points;
          }
        } catch {
          // A second uncached attempt follows; keep the last known-good series if both fail.
        }
      }
      return null;
    }

    async function refresh() {
      try {
        const readingResponse = await fetch("/api/readings", { cache: "no-store" });
        if (!active) return;
        if (readingResponse.ok) {
          const nextSnapshot = await readingResponse.json() as DashboardSnapshot;
          latestReadingAt = nextSnapshot.latestReadingAt;
          setSnapshot(nextSnapshot);
        }
      } catch {
        // Weather can still refresh against the last known meter timestamp.
      }

      const nextWeather = await fetchWeather();
      if (active && nextWeather) setWeather(nextWeather);
    }
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const readings = useMemo(() => selectRange(snapshot.readings, range), [snapshot.readings, range]);
  const latestMs = new Date(snapshot.latestReadingAt).getTime();
  const cutoffMs = latestMs - RANGE_HOURS[range] * 60 * 60 * 1000;
  const weatherInRange = weather.filter((point) => {
    const value = new Date(point.at).getTime();
    return value >= cutoffMs && value <= latestMs;
  });
  const totalKwh = readings.reduce((sum, reading) => sum + reading.kwh, 0);
  const peak = readings.reduce((highest, reading) => Math.max(highest, reading.averageKw), 0);
  const averageKw = readings.length
    ? readings.reduce((sum, reading) => sum + reading.averageKw, 0) / readings.length
    : 0;
  const averageTemperature = weatherInRange.length
    ? weatherInRange.reduce((sum, point) => sum + point.temperatureF, 0) / weatherInRange.length
    : null;
  const latestTemperature = weather.filter((point) => new Date(point.at).getTime() <= Date.now()).at(-1)?.temperatureF;
  const days = groupDays(snapshot.readings, weather).slice(-7);
  const maxDailyKwh = Math.max(...days.map((day) => day.kwh), 1);
  const coverageHours = readings.reduce(
    (hours, reading) => hours
      + Math.max(0, (new Date(reading.endsAt).getTime() - new Date(reading.startsAt).getTime()) / 3_600_000),
    0,
  );
  const lagMinutes = Math.max(0, Math.round((Date.now() - latestMs) / 60_000));
  const syncAgeMinutes = Math.max(
    0,
    Math.round((Date.now() - new Date(snapshot.lastSyncedAt).getTime()) / 60_000),
  );
  const collectorStale = snapshot.mode === "live" && syncAgeMinutes > 15;
  const coveragePercent = Math.min(100, Math.round((coverageHours / RANGE_HOURS[range]) * 100));
  const todayHours = Math.max(0.25, days.at(-1)?.hours ?? 0.25);

  const commonChart = (
    <>
      <div className={styles.chartHeading}>
        <div>
          <p className={styles.kicker}>Load + weather</p>
          <h2>{range === "3h" ? "3-hour trace" : range === "24h" ? "24-hour trace" : "7-day trace"}</h2>
        </div>
        <RangePicker value={range} onChange={setRange} />
      </div>
      <EnergyChart readings={readings} weather={weatherInRange} range={range} />
    </>
  );

  return (
    <div className={`${styles.shell} ${styles.gridDesk}`}>
      <AppHeader lagMinutes={lagMinutes} collectorStale={collectorStale} mode={snapshot.mode} />
      <main className={styles.denseMain}>
        <section className={styles.instrumentHead}>
          <div className={styles.instrumentTitle}>
            <p>Home · Live meter</p>
            <h1>{snapshot.currentKw.toFixed(3)} <span>kW</span></h1>
            <time dateTime={snapshot.latestReadingAt}>Interval end {formatTime(snapshot.latestReadingAt)}</time>
          </div>
          <dl className={styles.metricStrip} aria-label="Current and selected-window measurements">
            <div title="Energy recorded since midnight in New York."><dt>Today</dt><dd>{snapshot.todayKwh.toFixed(2)} <small>kWh</small></dd></div>
            <div title="Uses the configured variable rate plus a prorated share of fixed monthly charges."><dt>Today cost</dt><dd>{formatMoney(estimateCost(snapshot.todayKwh, todayHours, ratePerKwh, monthlyFixedCharge))} <small>est.</small></dd></div>
            <div title="Outdoor temperature near the configured location from Open-Meteo."><dt>Outside</dt><dd>{latestTemperature == null ? "—" : Math.round(latestTemperature)}<small>°F</small></dd></div>
            <div title="Energy contained in the selected chart window."><dt>Window</dt><dd>{totalKwh.toFixed(2)} <small>kWh</small></dd></div>
            <div title="Highest average demand across one 15-minute interval in the selected window."><dt>Peak</dt><dd>{peak.toFixed(2)} <small>kW</small></dd></div>
            <div title="Mean demand across all recorded intervals in the selected window."><dt>Mean</dt><dd>{averageKw.toFixed(2)} <small>kW</small></dd></div>
            <div title="Average outdoor temperature during the selected window."><dt>Mean outside</dt><dd>{averageTemperature == null ? "—" : averageTemperature.toFixed(1)}<small>°F</small></dd></div>
            <div title="Share of the selected time window represented by stored 15-minute readings."><dt>Coverage</dt><dd>{coveragePercent}<small>%</small></dd></div>
          </dl>
        </section>

        <section className={styles.instrumentChart}>
          {commonChart}
          <div className={styles.compactLegend}>
            <span><i className={styles.energyKey} />Demand · left axis</span>
            <span><i className={styles.tempKey} />Temperature · right axis</span>
            <details className={styles.chartHelp}>
              <summary aria-label="Explain this chart">?</summary>
              <p>Each electricity point is one 15-minute Con Edison interval. Hover or drag across the chart for exact values.</p>
            </details>
          </div>
        </section>

        <section className={styles.denseBottom}>
          <div className={styles.dailyPanel}>
            <header><h2>Daily ledger</h2><span>{(ratePerKwh * 100).toFixed(1)}¢/kWh + {formatMoney(monthlyFixedCharge)}/mo · all-in model</span></header>
            <div className={styles.tableScroll}>
              <table>
                <thead><tr><th>Date</th><th>Coverage</th><th>Energy</th><th>Cost</th><th>Avg temp</th><th>Peak</th></tr></thead>
                <tbody>
                  {days.map((day) => (
                    <tr key={day.key}>
                      <th scope="row">{day.label}</th>
                      <td>{day.complete ? "Full" : `${Math.round((day.hours / 24) * 100)}%`}</td>
                      <td><span className={styles.dayBar} style={{ "--day-fill": `${Math.max(4, (day.kwh / maxDailyKwh) * 100)}%` } as React.CSSProperties}>{day.kwh.toFixed(2)} kWh</span></td>
                      <td>{formatMoney(estimateCost(day.kwh, day.hours, ratePerKwh, monthlyFixedCharge))}</td>
                      <td>{day.averageF == null ? "—" : `${day.averageF.toFixed(1)}°F`}</td>
                      <td>{day.peakKw.toFixed(2)} kW</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <dl className={styles.systemPanel}>
            <div><dt>Source</dt><dd>{snapshot.mode === "live" ? "Con Edison" : "Demo"}</dd></div>
            <div><dt>Interval</dt><dd>15 min</dd></div>
            <div><dt>Latest</dt><dd>{formatTime(snapshot.latestReadingAt)}</dd></div>
            <div><dt>Synced</dt><dd>{formatTime(snapshot.lastSyncedAt)}</dd></div>
            <div><dt>Lag</dt><dd>{lagMinutes} min</dd></div>
            <div><dt>Samples</dt><dd>{readings.length}</dd></div>
          </dl>
        </section>
      </main>
    </div>
  );
}
