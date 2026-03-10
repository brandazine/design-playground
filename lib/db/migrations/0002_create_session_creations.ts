import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('session_creation')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('creating'))
    .addColumn('repository_id', 'text', (col) => col.notNull())
    .addColumn('base_branch', 'text', (col) => col.notNull())
    .addColumn('current_step', 'text', (col) => col.notNull().defaultTo(''))
    .addColumn('steps', 'jsonb', (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('session_id', 'uuid', (col) => col.references('session.session_id').onDelete('set null'))
    .addColumn('error', 'text')
    .addColumn('created_at', sql`timestamptz(6)`, (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', sql`timestamptz(6)`, (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('session_creation').execute();
}
