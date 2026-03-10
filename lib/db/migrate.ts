import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Migrator, FileMigrationProvider } from 'kysely';
import { db } from './kysely';

async function main() {
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(__dirname, 'migrations'),
    }),
  });

  const { error, results } = await migrator.migrateToLatest();

  for (const result of results ?? []) {
    if (result.status === 'Success') {
      console.log(`migrated: ${result.migrationName}`);
    } else if (result.status === 'Error') {
      console.error(`failed:   ${result.migrationName}`);
    }
  }

  if (error) {
    console.error('migration failed', error);
    process.exit(1);
  }

  await db.destroy();
}

main();
