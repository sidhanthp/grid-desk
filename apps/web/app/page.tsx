import { ElectricityDashboard } from "@/components/ElectricityDashboard";
import { getDashboardSnapshot } from "@/lib/data";

export const dynamic = "force-dynamic";

function nonNegativeNumber(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export default async function Home() {
  const snapshot = await getDashboardSnapshot();
  return (
    <ElectricityDashboard
      initialSnapshot={snapshot}
      ratePerKwh={nonNegativeNumber(process.env.ENERGY_RATE_PER_KWH, 0.338)}
      monthlyFixedCharge={nonNegativeNumber(process.env.MONTHLY_FIXED_CHARGE, 17.8)}
    />
  );
}
