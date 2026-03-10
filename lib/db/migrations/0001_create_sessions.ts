import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('session')
    .addColumn('session_id', 'uuid', (col) => col.primaryKey())
    .addColumn('user_id', 'text', (col) => col.notNull().defaultTo('dev'))
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('creating'))
    .addColumn('repository_id', 'text', (col) => col.notNull())
    .addColumn('repo_full_name', 'text', (col) => col.notNull())
    .addColumn('base_branch', 'text', (col) => col.notNull())
    .addColumn('branch', 'text', (col) => col.notNull())
    .addColumn('worktree_path', 'text', (col) => col.notNull())
    .addColumn('runtime_preset', 'text', (col) => col.notNull().defaultTo('local'))
    .addColumn('start_command', 'jsonb', (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('ready_path', 'text', (col) => col.notNull().defaultTo('/'))
    .addColumn('process_pid', 'integer')
    .addColumn('process_status', 'text', (col) => col.notNull().defaultTo('stopped'))
    .addColumn('last_proxy_request_at', sql`timestamptz(6)`, (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('dev_server_port', 'integer', (col) => col.notNull())
    .addColumn('preview_path', 'text', (col) => col.notNull())
    .addColumn('commit_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('pr_url', 'text')
    .addColumn('agentation_session_id', 'text')
    .addColumn('last_active_at', sql`timestamptz(6)`, (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('created_at', sql`timestamptz(6)`, (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('expires_at', sql`timestamptz(6)`, (col) => col.notNull().defaultTo(sql`now() + interval '2 hours'`))
    .execute();

  await db.schema.createIndex('idx_session_user').on('session').column('user_id').execute();
  await db.schema.createIndex('idx_session_status').on('session').column('status').execute();
  await db.schema.createIndex('uq_session_port').on('session').column('dev_server_port').unique().execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('session').execute();
}
