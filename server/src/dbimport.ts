import { DatabaseSync } from 'node:sqlite';
import { existsSync, renameSync, openSync, readSync, closeSync } from 'node:fs';

/**
 * One-time migration of an existing experiment database into a fresh deployment.
 *
 * Nothing is ever deleted: an uploaded file is staged as `<db>.import`, and at the
 * next boot it only replaces the live database if that database holds no
 * experiment. The replaced (empty) database is kept as a `.pre-import-*.bak`
 * file. A rejected upload is kept as `.import.rejected-*`.
 */

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

export function isSqliteFile(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(16);
    readSync(fd, buf, 0, 16, 0);
    return buf.toString('latin1') === 'SQLite format 3\0';
  } finally {
    closeSync(fd);
  }
}

/** Summary of an experiment database, or an error if it is not a usable one. */
export function inspectDb(path: string): { ok: true; experiments: number; trades: number; running: boolean; equityPoints: number } | { ok: false; error: string } {
  if (!existsSync(path)) return { ok: false, error: 'file not found' };
  if (!isSqliteFile(path)) return { ok: false, error: 'not an SQLite database' };
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const integrity = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
    if (integrity !== 'ok') return { ok: false, error: `integrity check failed: ${integrity}` };
    const n = (sql: string) => Number((db!.prepare(sql).get() as { n: number }).n);
    const has = (t: string) => n(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='${t}'`) > 0;
    if (!has('experiment')) return { ok: true, experiments: 0, trades: 0, running: false, equityPoints: 0 };
    return {
      ok: true,
      experiments: n('SELECT count(*) AS n FROM experiment'),
      trades: has('trades') ? n('SELECT count(*) AS n FROM trades') : 0,
      running: n("SELECT count(*) AS n FROM experiment WHERE status='running'") > 0,
      equityPoints: has('equity') ? n('SELECT count(*) AS n FROM equity') : 0,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    db?.close();
  }
}

/** Apply a staged `<db>.import` at boot, before the database is opened. Returns a log line or null. */
export function applyPendingImport(dbFile: string): string | null {
  const staged = `${dbFile}.import`;
  if (!existsSync(staged)) return null;

  const incoming = inspectDb(staged);
  if (!incoming.ok || incoming.experiments === 0) {
    const to = `${staged}.rejected-${stamp()}`;
    renameSync(staged, to);
    return `Import rejected (${incoming.ok ? 'no experiment in file' : incoming.error}); kept as ${to}`;
  }
  if (existsSync(dbFile)) {
    const current = inspectDb(dbFile);
    if (!current.ok || current.experiments > 0) {
      const to = `${staged}.rejected-${stamp()}`;
      renameSync(staged, to);
      return `Import refused: the live database already ${current.ok ? `holds ${current.experiments} experiment(s)` : `is unreadable (${current.error})`}; nothing was overwritten. Upload kept as ${to}`;
    }
    const bak = `${dbFile}.pre-import-${stamp()}.bak`;
    renameSync(dbFile, bak);
    for (const ext of ['-wal', '-shm']) if (existsSync(dbFile + ext)) renameSync(dbFile + ext, bak + ext);
  }
  renameSync(staged, dbFile);
  return `Imported database: ${incoming.experiments} experiment(s), ${incoming.trades} trades, ${incoming.equityPoints} equity points`;
}
