import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import { pool } from './connection';
import type { Database } from './types';

function createKysely(): Kysely<Database> {
  const g = globalThis as unknown as { __dpKysely?: Kysely<Database> };
  if (!g.__dpKysely) {
    g.__dpKysely = new Kysely<Database>({
      dialect: new PostgresDialect({ pool }),
      plugins: [new CamelCasePlugin()],
    });
  }
  return g.__dpKysely;
}

export const db = createKysely();
