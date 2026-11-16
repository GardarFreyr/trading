// Read-only market history for the dashboard's trade charts.
//
// Candles come from GeckoTerminal for the exact liquidity pool the engine traded
// (positions.pairAddress). Nothing here is synthesised: missing intervals stay
// missing, and an unavailable source is reported as an error, never filled in.
// This module only reads the database and never touches the engine, strategy,
// risk limits or execution.
import { FeedError, getJson } from './feeds/http.ts';
import type { Store } from './db.ts';
import type { Config } from './config.ts';

const BASE = 'https://api.geckoterminal.com/api/v2/networks/solana';
const WSOL = 'So11111111111111111111111111111111111111112';

export const TIMEFRAMES = {
  '1m': { path: 'minute', aggregate: 1, sec: 60 },
  '5m': { path: 'minute', aggregate: 5, sec: 300 },
  '15m': { path: 'minute', aggregate: 15, sec: 900 },
  '1h': { path: 'hour', aggregate: 1, sec: 3600 },
  '4h': { path: 'hour', aggregate: 4, sec: 14_400 },
  '1D': { path: 'day', aggregate: 1, sec: 86_400 },
} as const;
export type Timeframe = keyof typeof TIMEFRAMES;

export class ChartError extends Error {
  status: number;
  retryAfter?: number;
  constructor(message: string, status: number, retryAfter?: number) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

// ---------- Rate limiting + cache (GeckoTerminal's public API allows ~30 calls/min) ----------

const LIMIT_PER_MIN = 10;
const calls: number[] = [];
const cache = new Map<string, { at: number; ttl: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>, now = Date.now()): Promise<T> {
  const hit = cache.get(key);
  if (hit && now - hit.at < hit.ttl) return hit.value as T;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  while (calls.length && now - calls[0] > 60_000) calls.shift();
  if (calls.length >= LIMIT_PER_MIN) {
    if (hit) return hit.value as T; // stale but real data beats an error
    throw new ChartError('Market data rate limit reached. Try again shortly.', 429, Math.ceil((60_000 - (now - calls[0])) / 1000));
  }
  calls.push(now);
  const p = load()
    .then((value) => {
      cache.set(key, { at: Date.now(), ttl: ttlMs, value });
      if (cache.size > 300) cache.delete(cache.keys().next().value as string);
      return value;
    })
    .catch((e: unknown) => {
      if (hit) return hit.value as T;
      if (e instanceof FeedError && e.status === 429) throw new ChartError('GeckoTerminal rate limit reached. Try again in a minute.', 429, 60);
      if (e instanceof FeedError && e.status === 404) throw new ChartError('This pool is not indexed by GeckoTerminal.', 404);
      throw new ChartError(`Market data unavailable: ${(e as Error).message}`, 502);
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p as Promise<T>;
}

// ---------- Provider ----------

interface GtPool {
  data: {
    attributes: {
      name: string;
      base_token_price_usd: string | null;
      base_token_price_quote_token: string | null;
      fdv_usd: string | null;
      market_cap_usd: string | null;
      reserve_in_usd: string | null;
      volume_usd?: { h24?: string | null };
      pool_created_at?: string | null;
    };
    relationships: { base_token: { data: { id: string } }; quote_token: { data: { id: string } }; dex?: { data: { id: string } } };
  };
}
interface GtOhlcv {
  data: { attributes: { ohlcv_list: [number, number, number, number, number, number][] } };
  meta?: { base?: { address: string; name: string; symbol: string }; quote?: { address: string; symbol: string } };
}

const num = (v: string | null | undefined) => (v == null || v === '' ? null : Number(v));
const tokenAddr = (id: string) => id.replace(/^solana_/, '');

export interface PoolInfo {
  address: string;
  name: string;
  dex: string | null;
  baseAddress: string;
  quoteAddress: string;
  quoteIsSol: boolean;
  priceUsd: number | null;
  priceQuote: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  createdAt: number | null;
}

export function poolInfo(pool: string): Promise<PoolInfo> {
  return cached(`pool:${pool}`, 300_000, async () => {
    const r = await getJson<GtPool>(`${BASE}/pools/${pool}`);
    const a = r.data.attributes;
    const quote = tokenAddr(r.data.relationships.quote_token.data.id);
    return {
      address: pool,
      name: a.name,
      dex: r.data.relationships.dex?.data.id ?? null,
      baseAddress: tokenAddr(r.data.relationships.base_token.data.id),
      quoteAddress: quote,
      quoteIsSol: quote === WSOL,
      priceUsd: num(a.base_token_price_usd),
      priceQuote: num(a.base_token_price_quote_token),
      liquidityUsd: num(a.reserve_in_usd),
      volume24hUsd: num(a.volume_usd?.h24),
      marketCapUsd: num(a.market_cap_usd),
      fdvUsd: num(a.fdv_usd),
      createdAt: a.pool_created_at ? Date.parse(a.pool_created_at) : null,
    };
  });
}

export interface Candle {
  time: number; // unix seconds, candle open
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * OHLCV for one pool, priced in SOL when the pool is quoted in SOL (the unit the
 * engine records fills in), otherwise in USD. `token` selects which side's price.
 */
export function candles(pool: string, baseToken: string, tf: Timeframe, currency: 'token' | 'usd', beforeSec: number | null, limit: number): Promise<Candle[]> {
  const t = TIMEFRAMES[tf];
  const historical = beforeSec != null && beforeSec < Date.now() / 1000 - 2 * t.sec;
  const ttl = historical ? 3_600_000 : Math.max(15_000, Math.min(120_000, t.sec * 250));
  const key = `ohlcv:${pool}:${tf}:${currency}:${beforeSec ?? 'now'}:${limit}`;
  return cached(key, ttl, async () => {
    const q = new URLSearchParams({ aggregate: String(t.aggregate), limit: String(limit), currency, token: baseToken });
    if (beforeSec != null) q.set('before_timestamp', String(beforeSec));
    const r = await getJson<GtOhlcv>(`${BASE}/pools/${pool}/ohlcv/${t.path}?${q}`);
    const rows = r.data?.attributes?.ohlcv_list ?? [];
    return rows
      .filter((c) => c.length >= 6 && c.slice(1, 5).every((v) => Number.isFinite(v) && v > 0))
      .map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }))
      .sort((a, b) => a.time - b.time);
  });
}

// ---------- Position chart payload ----------

interface PositionRow {
  id: number; experimentId: number; tokenAddress: string; symbol: string; pairAddress: string; status: string;
  openedAt: number; closedAt: number | null; tokenAmount: number; costIsk: number; entryPriceSol: number; entryMarkSol: number;
  peakPriceSol: number; lastMarkSol: number; exitReason: string | null; exitKind: string | null; proceedsIsk: number | null;
  extraFeesIsk: number; netPnlIsk: number | null;
}
interface TradeRow {
  id: number; ts: number; side: 'BUY' | 'SELL'; status: string; markPriceSol: number; quotedPriceSol: number; fillPriceSol: number | null;
  solAmount: number; tokenAmount: number; iskAmount: number; feeIsk: number; slippageIsk: number; reason: string; failReason: string | null; assumptions: string;
}

export function pickTimeframe(durationMs: number): Timeframe {
  const h = durationMs / 3_600_000;
  return h < 1.5 ? '1m' : h < 6 ? '5m' : h < 18 ? '15m' : h < 72 ? '1h' : '4h';
}

export async function positionChart(store: Store, cfg: Config, id: number, tfIn: string | null, now = Date.now()) {
  const p = store.db.prepare('SELECT * FROM positions WHERE id = ?').get(id) as PositionRow | undefined;
  if (!p) throw new ChartError('Position not found', 404);
  const trades = store.db
    .prepare(`SELECT id, ts, side, status, markPriceSol, quotedPriceSol, fillPriceSol, solAmount, tokenAmount, iskAmount, feeIsk, slippageIsk,
              reason, failReason, assumptions FROM trades WHERE positionId = ? ORDER BY ts`)
    .all(id) as unknown as TradeRow[];
  const tok = store.token(p.tokenAddress);
  const end = p.closedAt ?? now;
  const tf: Timeframe = tfIn && tfIn in TIMEFRAMES ? (tfIn as Timeframe) : pickTimeframe(end - p.openedAt);
  const sec = TIMEFRAMES[tf].sec;

  // Window: the whole trade plus context on both sides, capped at the provider's 1000 candles.
  const padSec = Math.max(60 * sec, ((end - p.openedAt) / 1000) * 0.35);
  const fromSec = Math.floor(p.openedAt / 1000 - padSec);
  const toSec = Math.min(Math.floor(now / 1000), Math.ceil(end / 1000 + padSec));
  const wanted = Math.ceil((toSec - fromSec) / sec) + 1;
  const limit = Math.max(100, Math.min(1000, wanted));
  const before = toSec >= now / 1000 - sec ? null : toSec + sec;

  let pool: PoolInfo | null = null;
  let currency: 'token' | 'usd' = 'token';
  let rows: Candle[] = [];
  let candleError: { message: string; status: number; retryAfter?: number } | null = null;
  try {
    pool = await poolInfo(p.pairAddress);
    currency = pool.quoteIsSol ? 'token' : 'usd';
    rows = await candles(p.pairAddress, p.tokenAddress, tf, currency, before, limit);
  } catch (e) {
    const ce = e as ChartError;
    candleError = { message: ce.message, status: ce.status ?? 502, retryAfter: ce.retryAfter };
  }

  const entryTrade = trades.find((t) => t.side === 'BUY' && t.status === 'FILLED');
  const fx = (t?: TradeRow) => {
    try { return t ? (JSON.parse(t.assumptions).fx?.solUsd as number | undefined) ?? null : null; } catch { return null; }
  };
  return {
    simulated: true,
    position: {
      id: p.id, symbol: p.symbol, name: tok?.name ?? p.symbol, tokenAddress: p.tokenAddress, pairAddress: p.pairAddress,
      status: p.status, openedAt: p.openedAt, closedAt: p.closedAt, tokenAmount: p.tokenAmount, costIsk: p.costIsk,
      entryPriceSol: p.entryPriceSol, entryMarkSol: p.entryMarkSol, peakPriceSol: p.peakPriceSol, lastMarkSol: p.lastMarkSol,
      exitReason: p.exitReason, exitKind: p.exitKind, proceedsIsk: p.proceedsIsk, extraFeesIsk: p.extraFeesIsk, netPnlIsk: p.netPnlIsk,
      // Engine rules (risk.ts): fixed SL/TP from the simulated entry fill.
      slPriceSol: p.entryPriceSol * (1 - cfg.stopLossPct),
      tpPriceSol: p.entryPriceSol * (1 + cfg.takeProfitPct),
      entrySolUsd: fx(entryTrade),
    },
    trades: trades.map((t) => ({ ...t, solUsd: fx(t), assumptions: undefined })),
    pool,
    chart: {
      timeframe: tf,
      unit: currency === 'token' ? ('SOL' as const) : ('USD' as const),
      volumeUnit: currency === 'token' ? 'SOL' : 'USD',
      source: 'GeckoTerminal',
      windowFrom: fromSec,
      windowTo: toSec,
      truncated: wanted > 1000,
      candles: rows,
      error: candleError,
    },
  };
}
