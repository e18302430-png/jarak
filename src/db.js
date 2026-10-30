// Postgres in production (DATABASE_URL from Supabase/Neon), embedded PGlite for local runs and tests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));

let impl = null;

export async function initDb({ url = process.env.DATABASE_URL, dataDir = process.env.PGLITE_DIR } = {}) {
  if (url) {
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false }, max: 5 });
    impl = { query: (text, params) => pool.query(text, params), exec: (sql) => pool.query(sql), close: () => pool.end(), kind: 'pg' };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const db = dataDir ? new PGlite(dataDir) : new PGlite();
    impl = { query: (text, params) => db.query(text, params), exec: (sql) => db.exec(sql), close: () => db.close(), kind: 'pglite' };
  }
  await impl.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
  return impl;
}

export const q = async (text, params = []) => (await impl.query(text, params)).rows;
export const one = async (text, params = []) => (await q(text, params))[0] || null;
export const dbKind = () => impl && impl.kind;
export const closeDb = () => impl && impl.close();
