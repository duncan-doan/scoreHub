// npm run backup: copies the database with SQLite's own backup, which is safe while the app is running.
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { DATA_DIR, DB_FILE } from './db.js';

const stamp = new Date().toISOString().slice(0, 16).replace(':', ''); // e.g. 2026-11-03T1405 (UTC)
const dest = join(DATA_DIR, `backup-${stamp}.db`);
const db = new Database(DB_FILE, { readonly: true, fileMustExist: true });
await db.backup(dest);
db.close();
console.log(`Saved ${dest}`);
