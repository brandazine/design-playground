import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('worker_registry')
    .addColumn('worker_id', 'uuid', (col) => col.primaryKey())
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('active'))
    .addColumn('last_heartbeat', sql`timestamptz(6)`, (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('started_at', sql`timestamptz(6)`, (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('hostname', 'text')
    .addColumn('pid', 'integer')
    .addColumn('metadata', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('worker_registry').execute();
}
