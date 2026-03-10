import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('comment')
    .addColumn('comment_id', 'uuid', (col) => col.primaryKey())
    .addColumn('session_id', 'uuid', (col) => col.notNull().references('session.session_id').onDelete('cascade'))
    .addColumn('agentation_annotation_id', 'text')
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('open'))
    .addColumn('category', 'text', (col) => col.notNull().defaultTo('general'))
    .addColumn('element', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('metadata', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('created_at', sql`timestamptz(6)`, (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('resolved_at', sql`timestamptz(6)`)
    .execute();

  await db.schema.createIndex('idx_comment_session').on('comment').column('session_id').execute();
  await db.schema.createIndex('idx_comment_status').on('comment').columns(['session_id', 'status']).execute();

  await db.schema
    .createTable('comment_message')
    .addColumn('message_id', 'uuid', (col) => col.primaryKey())
    .addColumn('comment_id', 'uuid', (col) => col.notNull().references('comment.comment_id').onDelete('cascade'))
    .addColumn('role', 'text', (col) => col.notNull())
    .addColumn('content', 'text', (col) => col.notNull())
    .addColumn('code_changes', 'jsonb')
    .addColumn('created_at', sql`timestamptz(6)`, (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema.createIndex('idx_message_comment').on('comment_message').column('comment_id').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('comment_message').execute();
  await db.schema.dropTable('comment').execute();
}
