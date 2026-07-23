import { Pool } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var electricityPool: Pool | undefined;
}

export function getPool(): Pool | null {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return null;

  if (!global.electricityPool) {
    const hostname = new URL(connectionString).hostname;
    const isLocal = hostname === "localhost" || hostname === "127.0.0.1";
    const isRailwayPrivate = hostname.endsWith(".railway.internal");
    const sslDisabled = process.env.DATABASE_SSL?.toLowerCase() === "disable";
    global.electricityPool = new Pool({
      connectionString,
      max: 5,
      ssl: isLocal || sslDisabled ? false : { rejectUnauthorized: !isRailwayPrivate },
    });
  }

  return global.electricityPool;
}
