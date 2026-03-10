import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('ai_session')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('session_id', 'uuid', (col) => col.notNull().references('session.session_id').onDelete('cascade'))
    .addColumn('provider', 'text', (col) => col.notNull().defaultTo('claude'))
    .addColumn('provider_session_id', 'text', (col) => col.notNull())
    .addColumn('created_at', sql`timestamptz(6)`, (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('last_used_at', sql`timestamptz(6)`, (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema.createIndex('idx_ai_session').on('ai_session').column('session_id').execute();
  await db.schema.createIndex('idx_ai_session_provider').on('ai_session').columns(['session_id', 'provider']).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('ai_session').execute();
}
