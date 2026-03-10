import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('command_queue')
    .addColumn('command_id', 'uuid', (col) => col.primaryKey())
    .addColumn('session_id', 'uuid', (col) => col.notNull().references('session.session_id').onDelete('cascade'))
    .addColumn('comment_id', 'uuid', (col) => col.references('comment.comment_id'))
    .addColumn('type', 'text', (col) => col.notNull())
    .addColumn('payload', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('queued'))
    .addColumn('result', 'jsonb')
    .addColumn('worker_id', 'uuid')
    .addColumn('created_at', sql`timestamptz(6)`, (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('started_at', sql`timestamptz(6)`)
    .addColumn('completed_at', sql`timestamptz(6)`)
    .addColumn('cancelled_at', sql`timestamptz(6)`)
    .execute();

  await db.schema.createIndex('idx_command_session').on('command_queue').column('session_id').execute();
  await db.schema.createIndex('idx_command_status').on('command_queue').column('status').execute();
  await sql`CREATE UNIQUE INDEX uq_command_processing_session ON command_queue(session_id) WHERE status = 'processing'`.execute(db);

  await db.schema
    .createTable('command_event')
    .addColumn('id', 'bigserial', (col) => col.primaryKey())
    .addColumn('command_id', 'uuid', (col) => col.notNull().references('command_queue.command_id').onDelete('cascade'))
    .addColumn('session_id', 'uuid', (col) => col.notNull())
    .addColumn('event_type', 'text', (col) => col.notNull())
    .addColumn('payload', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('created_at', sql`timestamptz(6)`, (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema.createIndex('idx_event_command').on('command_event').column('command_id').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('command_event').execute();
  await db.schema.dropTable('command_queue').execute();
}
