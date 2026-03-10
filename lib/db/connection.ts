import pg from 'pg';

const { Pool } = pg;

function getPool(): pg.Pool {
  const g = globalThis as unknown as { __dpPool?: pg.Pool };
  if (!g.__dpPool) {
    g.__dpPool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });
  }
  return g.__dpPool;
}

export const pool = getPool();
