export type Reading = {
  startsAt: string;
  endsAt: string;
  kwh: number;
  averageKw: number;
};
export type DashboardSnapshot = {
  mode: "live" | "demo";
  readings: Reading[];
  latestReadingAt: string;
  lastSyncedAt: string;
  currentKw: number;
  todayKwh: number;
  projectedMonthKwh: number;
  quietestWindow: string;
};
