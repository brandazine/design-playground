import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('session_skill')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('session_id', 'uuid', (col) => col.notNull().references('session.session_id').onDelete('cascade'))
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('scope', 'text', (col) => col.notNull().defaultTo('system'))
    .addColumn('trigger', 'text', (col) => col.notNull().defaultTo('always'))
    .addColumn('categories', 'jsonb')
    .addColumn('instructions', 'text', (col) => col.notNull())
    .addColumn('priority', 'integer', (col) => col.notNull().defaultTo(50))
    .addColumn('created_at', sql`timestamptz(6)`, (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema.createIndex('idx_session_skill').on('session_skill').column('session_id').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('session_skill').execute();
}
