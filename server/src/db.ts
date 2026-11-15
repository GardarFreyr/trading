import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Experiment {
  id: number;
  startedAt: number;
  endsAt: number;
  initialIsk: number;
  cashIsk: number;
  status: 'running' | 'finished';
  solUsdStart: number;
  iskPerUsdStart: number;
  finishedAt: number | null;
  reportJson: string | null;
}

export interface Position {
  id: number;
  experimentId: number;
  tokenAddress: string;
  symbol: string;
  pairAddress: string;
  decimals: number;
  status: 'open' | 'closed';
  openedAt: number;
  closedAt: number | null;
  tokenAmount: number;
  solIn: number;
  costIsk: number;
  entryPriceSol: number;
  entryMarkSol: number;
  peakPriceSol: number;
  lastMarkSol: number;
  entryReason: string;
  exitReason: string | null;
  exitKind: string | null;
  proceedsIsk: number | null;
  extraFeesIsk: number;
  netPnlIsk: number | null;
  exitAttempts: number;
}

export interface Trade {
  id: number;
  experimentId: number;
  positionId: number | null;
  ts: number;
  side: 'BUY' | 'SELL';
  status: 'FILLED' | 'FAILED';
  tokenAddress: string;
  symbol: string;
  quoteSource: string;
  route: string;
  markPriceSol: number;
  quotedPriceSol: number;
  fillPriceSol: number | null;
  solAmount: number;
  tokenAmount: number;
  iskAmount: number;
  solIsk: number;
  feeSol: number;
  feeIsk: number;
  priceImpactPct: number;
  latencySlippageBps: number;
  slippageVsMarkBps: number | null;
  slippageIsk: number;
  reason: string;
  failReason: string | null;
  assumptions: string;
}

export interface TokenRow {
  address: string;
  symbol: string;
  name: string;
  pairAddress: string;
  firstSeen: number;
  lastSeen: number;
  status: 'watching' | 'rejected' | 'unsafe';
  rejectReason: string | null;
  score: number | null;
  scoreExplanation: string | null;
  marketJson: string | null;
  safetyJson: string | null;
  safetyCheckedAt: number | null;
  lastExitAt: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS experiment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  startedAt INTEGER NOT NULL, endsAt INTEGER NOT NULL,
  initialIsk REAL NOT NULL, cashIsk REAL NOT NULL,
  status TEXT NOT NULL, solUsdStart REAL NOT NULL, iskPerUsdStart REAL NOT NULL,
  finishedAt INTEGER, reportJson TEXT
);
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, experimentId INTEGER NOT NULL,
  tokenAddress TEXT NOT NULL, symbol TEXT NOT NULL, pairAddress TEXT NOT NULL, decimals INTEGER NOT NULL,
  status TEXT NOT NULL, openedAt INTEGER NOT NULL, closedAt INTEGER,
  tokenAmount REAL NOT NULL, solIn REAL NOT NULL, costIsk REAL NOT NULL,
  entryPriceSol REAL NOT NULL, entryMarkSol REAL NOT NULL, peakPriceSol REAL NOT NULL, lastMarkSol REAL NOT NULL,
  entryReason TEXT NOT NULL, exitReason TEXT, exitKind TEXT,
  proceedsIsk REAL, extraFeesIsk REAL NOT NULL DEFAULT 0, netPnlIsk REAL, exitAttempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT, experimentId INTEGER NOT NULL, positionId INTEGER,
  ts INTEGER NOT NULL, side TEXT NOT NULL, status TEXT NOT NULL,
  tokenAddress TEXT NOT NULL, symbol TEXT NOT NULL, quoteSource TEXT NOT NULL, route TEXT NOT NULL,
  markPriceSol REAL NOT NULL, quotedPriceSol REAL NOT NULL, fillPriceSol REAL,
  solAmount REAL NOT NULL, tokenAmount REAL NOT NULL, iskAmount REAL NOT NULL, solIsk REAL NOT NULL,
  feeSol REAL NOT NULL, feeIsk REAL NOT NULL, priceImpactPct REAL NOT NULL,
  latencySlippageBps REAL NOT NULL, slippageVsMarkBps REAL, slippageIsk REAL NOT NULL,
  reason TEXT NOT NULL, failReason TEXT, assumptions TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS equity (
  experimentId INTEGER NOT NULL, ts INTEGER NOT NULL, equityIsk REAL NOT NULL,
  cashIsk REAL NOT NULL, positionsIsk REAL NOT NULL, solHoldIsk REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS equity_ts ON equity(experimentId, ts);
CREATE TABLE IF NOT EXISTS day_start (
  experimentId INTEGER NOT NULL, day TEXT NOT NULL, equityIsk REAL NOT NULL, PRIMARY KEY (experimentId, day)
);
CREATE TABLE IF NOT EXISTS tokens (
  address TEXT PRIMARY KEY, symbol TEXT NOT NULL, name TEXT NOT NULL, pairAddress TEXT NOT NULL,
  firstSeen INTEGER NOT NULL, lastSeen INTEGER NOT NULL, status TEXT NOT NULL,
  rejectReason TEXT, score REAL, scoreExplanation TEXT, marketJson TEXT,
  safetyJson TEXT, safetyCheckedAt INTEGER, lastExitAt INTEGER
);
CREATE TABLE IF NOT EXISTS snapshots (address TEXT NOT NULL, ts INTEGER NOT NULL, priceUsd REAL NOT NULL);
CREATE INDEX IF NOT EXISTS snapshots_addr_ts ON snapshots(address, ts);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS health (
  feed TEXT PRIMARY KEY, lastOk INTEGER, lastError TEXT, lastErrorAt INTEGER, latencyMs INTEGER, okCount INTEGER NOT NULL DEFAULT 0, errCount INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

type Row = Record<string, unknown>;

export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.db.exec(SCHEMA);
  }

  /** Atomic unit of work: either every write lands or none does (crash-safe). */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private all<T>(sql: string, ...p: unknown[]): T[] {
    return this.db.prepare(sql).all(...(p as never[])) as T[];
  }
  private get<T>(sql: string, ...p: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...(p as never[])) as T | undefined;
  }
  private run(sql: string, ...p: unknown[]) {
    return this.db.prepare(sql).run(...(p as never[]));
  }
  private insert(table: string, obj: Row): number {
    const keys = Object.keys(obj);
    const r = this.run(
      `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      ...keys.map((k) => obj[k] ?? null),
    );
    return Number(r.lastInsertRowid);
  }
  private update(table: string, key: string, id: unknown, obj: Row) {
    const keys = Object.keys(obj);
    this.run(`UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(',')} WHERE ${key}=?`, ...keys.map((k) => obj[k] ?? null), id);
  }

  // Experiment
  experiment(): Experiment | undefined {
    return this.get<Experiment>('SELECT * FROM experiment ORDER BY id DESC LIMIT 1');
  }
  createExperiment(e: Omit<Experiment, 'id' | 'finishedAt' | 'reportJson'>): number {
    return this.insert('experiment', e as unknown as Row);
  }
  updateExperiment(id: number, patch: Partial<Experiment>) {
    this.update('experiment', 'id', id, patch as Row);
  }

  // Positions
  openPositions(expId: number): Position[] {
    return this.all('SELECT * FROM positions WHERE experimentId=? AND status=? ORDER BY openedAt', expId, 'open');
  }
  closedPositions(expId: number): Position[] {
    return this.all('SELECT * FROM positions WHERE experimentId=? AND status=? ORDER BY closedAt DESC', expId, 'closed');
  }
  insertPosition(p: Omit<Position, 'id'>): number {
    return this.insert('positions', p as unknown as Row);
  }
  updatePosition(id: number, patch: Partial<Position>) {
    this.update('positions', 'id', id, patch as Row);
  }

  // Trades
  insertTrade(t: Omit<Trade, 'id'>): number {
    return this.insert('trades', t as unknown as Row);
  }
  trades(expId: number, limit = 1_000_000): Trade[] {
    return this.all('SELECT * FROM trades WHERE experimentId=? ORDER BY ts DESC, id DESC LIMIT ?', expId, limit);
  }
  tradeTotals(expId: number) {
    return this.get<{ feeIsk: number; slippageIsk: number; failed: number; filled: number }>(
      `SELECT COALESCE(SUM(feeIsk),0) feeIsk, COALESCE(SUM(slippageIsk),0) slippageIsk,
              SUM(status='FAILED') failed, SUM(status='FILLED') filled FROM trades WHERE experimentId=?`,
      expId,
    )!;
  }

  // Equity
  addEquity(row: { experimentId: number; ts: number; equityIsk: number; cashIsk: number; positionsIsk: number; solHoldIsk: number }) {
    this.insert('equity', row);
  }
  equity(expId: number) {
    return this.all<{ ts: number; equityIsk: number; cashIsk: number; positionsIsk: number; solHoldIsk: number }>(
      'SELECT ts, equityIsk, cashIsk, positionsIsk, solHoldIsk FROM equity WHERE experimentId=? ORDER BY ts',
      expId,
    );
  }
  dayStart(expId: number, day: string): number | undefined {
    return this.get<{ equityIsk: number }>('SELECT equityIsk FROM day_start WHERE experimentId=? AND day=?', expId, day)?.equityIsk;
  }
  setDayStart(expId: number, day: string, equityIsk: number) {
    this.run('INSERT OR IGNORE INTO day_start (experimentId, day, equityIsk) VALUES (?,?,?)', expId, day, equityIsk);
  }
  dayStarts(expId: number) {
    return this.all<{ day: string; equityIsk: number }>('SELECT day, equityIsk FROM day_start WHERE experimentId=? ORDER BY day', expId);
  }

  // Tokens
  token(address: string): TokenRow | undefined {
    return this.get('SELECT * FROM tokens WHERE address=?', address);
  }
  tokens(): TokenRow[] {
    return this.all('SELECT * FROM tokens ORDER BY lastSeen DESC');
  }
  upsertToken(t: Pick<TokenRow, 'address' | 'symbol' | 'name' | 'pairAddress'>, now: number) {
    this.run(
      `INSERT INTO tokens (address, symbol, name, pairAddress, firstSeen, lastSeen, status) VALUES (?,?,?,?,?,?, 'watching')
       ON CONFLICT(address) DO UPDATE SET symbol=excluded.symbol, name=excluded.name, pairAddress=excluded.pairAddress, lastSeen=excluded.lastSeen`,
      t.address, t.symbol, t.name, t.pairAddress, now, now,
    );
  }
  updateToken(address: string, patch: Partial<TokenRow>) {
    this.update('tokens', 'address', address, patch as Row);
  }
  deleteToken(address: string) {
    this.run('DELETE FROM tokens WHERE address=?', address);
    this.run('DELETE FROM snapshots WHERE address=?', address);
  }

  // Snapshots (our own forward observations)
  addSnapshot(address: string, ts: number, priceUsd: number) {
    this.run('INSERT INTO snapshots (address, ts, priceUsd) VALUES (?,?,?)', address, ts, priceUsd);
  }
  history(address: string, since: number) {
    return this.all<{ ts: number; priceUsd: number }>('SELECT ts, priceUsd FROM snapshots WHERE address=? AND ts>=? ORDER BY ts', address, since);
  }
  pruneSnapshots(before: number) {
    this.run('DELETE FROM snapshots WHERE ts<?', before);
  }

  // Events / health / kv
  event(level: 'info' | 'warn' | 'error' | 'trade', message: string, ts = Date.now()) {
    this.run('INSERT INTO events (ts, level, message) VALUES (?,?,?)', ts, level, message);
  }
  events(limit = 50) {
    return this.all<{ id: number; ts: number; level: string; message: string }>('SELECT * FROM events ORDER BY id DESC LIMIT ?', limit);
  }
  healthOk(feed: string, latencyMs: number, ts = Date.now()) {
    this.run(
      `INSERT INTO health (feed, lastOk, latencyMs, okCount) VALUES (?,?,?,1)
       ON CONFLICT(feed) DO UPDATE SET lastOk=excluded.lastOk, latencyMs=excluded.latencyMs, okCount=okCount+1`,
      feed, ts, latencyMs,
    );
  }
  healthErr(feed: string, err: string, ts = Date.now()) {
    this.run(
      `INSERT INTO health (feed, lastError, lastErrorAt, errCount) VALUES (?,?,?,1)
       ON CONFLICT(feed) DO UPDATE SET lastError=excluded.lastError, lastErrorAt=excluded.lastErrorAt, errCount=errCount+1`,
      feed, err.slice(0, 300), ts,
    );
  }
  health() {
    return this.all<{ feed: string; lastOk: number | null; lastError: string | null; lastErrorAt: number | null; latencyMs: number | null; okCount: number; errCount: number }>(
      'SELECT * FROM health ORDER BY feed',
    );
  }
  kvGet(key: string): string | undefined {
    return this.get<{ value: string }>('SELECT value FROM kv WHERE key=?', key)?.value;
  }
  kvSet(key: string, value: string) {
    this.run('INSERT INTO kv (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value);
  }

  close() {
    this.db.close();
  }
}
