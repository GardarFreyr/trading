import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { ChartError, pickTimeframe, positionChart } from '../src/candles.ts';

const WSOL = 'So11111111111111111111111111111111111111112';
const MINT = 'Mint1111111111111111111111111111111111pump';
const POOL = 'Pool111111111111111111111111111111111111111';

function seed(store: Store, openedAt: number, closedAt: number | null) {
  store.db.prepare(`INSERT INTO positions (id, experimentId, tokenAddress, symbol, pairAddress, decimals, status, openedAt, closedAt, tokenAmount, solIn, costIsk,
    entryPriceSol, entryMarkSol, peakPriceSol, lastMarkSol, entryReason, extraFeesIsk) VALUES (1, 1, ?, 'TST', ?, 6, ?, ?, ?, 1000, 0.1, 700, 0.00001, 0.0000098, 0.00001, 0.00001, 'test', 0)`)
    .run(MINT, POOL, closedAt ? 'closed' : 'open', openedAt, closedAt);
  store.db.prepare(`INSERT INTO trades (experimentId, positionId, ts, side, status, tokenAddress, symbol, quoteSource, route, markPriceSol, quotedPriceSol, fillPriceSol,
    solAmount, tokenAmount, iskAmount, solIsk, feeSol, feeIsk, priceImpactPct, latencySlippageBps, slippageVsMarkBps, slippageIsk, reason, assumptions)
    VALUES (1, 1, ?, 'BUY', 'FILLED', ?, 'TST', 'jupiter', 'x', 0.0000098, 0.0000099, 0.00001, 0.1, 1000, 700, 9000, 0.00002, 0.2, 0.5, 10, 200, 14, 'test', ?)`)
    .run(openedAt, MINT, JSON.stringify({ fx: { solUsd: 150, iskPerUsd: 125 } }));
}

function mockFetch(handler: (url: string) => { status: number; body: unknown }) {
  const calls: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const r = handler(url);
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = orig) };
}

const poolBody = (quote: string) => ({
  data: {
    attributes: { name: 'TST / SOL', base_token_price_usd: '0.0015', base_token_price_quote_token: '0.00001', fdv_usd: '1500000', market_cap_usd: null, reserve_in_usd: '80000', volume_usd: { h24: '500000' } },
    relationships: { base_token: { data: { id: `solana_${MINT}` } }, quote_token: { data: { id: `solana_${quote}` } }, dex: { data: { id: 'pumpswap' } } },
  },
});

test('timeframe follows trade length', () => {
  assert.equal(pickTimeframe(30 * 60_000), '1m');
  assert.equal(pickTimeframe(4 * 3_600_000), '5m');
  assert.equal(pickTimeframe(12 * 3_600_000), '15m');
  assert.equal(pickTimeframe(2 * 86_400_000), '1h');
});

test('chart uses the stored pool, prices in SOL, keeps gaps and drops invalid rows', async () => {
  const store = new Store(':memory:');
  const now = Date.UTC(2026, 10, 16, 12, 0);
  seed(store, now - 3_600_000, null);
  const t0 = Math.floor((now - 3_600_000) / 1000);
  const m = mockFetch((url) => {
    if (url.includes('/ohlcv/')) return {
      status: 200,
      body: { data: { attributes: { ohlcv_list: [[t0 + 120, 1, 2, 0.5, 1.5, 10], [t0, 1, 1.2, 0.9, 1.1, 5], [t0 + 60, 0, 0, 0, 0, 0]] } } },
    };
    return { status: 200, body: poolBody(WSOL) };
  });
  try {
    const r = await positionChart(store, defaultConfig, 1, '1m', now);
    assert.ok(m.calls.every((u) => u.includes(`/pools/${POOL}`)), 'only the traded pool is queried');
    const ohlcv = m.calls.find((u) => u.includes('/ohlcv/'))!;
    assert.match(ohlcv, /currency=token/);
    assert.match(ohlcv, new RegExp(`token=${MINT}`));
    assert.equal(r.chart.unit, 'SOL');
    assert.deepEqual(r.chart.candles.map((c) => c.time), [t0, t0 + 120], 'sorted, zero row dropped, gap left empty');
    assert.equal(r.position.slPriceSol, 0.00001 * (1 - defaultConfig.stopLossPct));
    assert.equal(r.position.tpPriceSol, 0.00001 * (1 + defaultConfig.takeProfitPct));
    assert.equal(r.trades[0].fillPriceSol, 0.00001);
    assert.equal(r.trades[0].solUsd, 150);
  } finally {
    m.restore();
  }
});

test('non-SOL pool falls back to USD candles', async () => {
  const store = new Store(':memory:');
  const now = Date.UTC(2026, 10, 16, 13, 0);
  seed(store, now - 2 * 86_400_000, now - 2 * 86_400_000 + 3_600_000);
  store.db.exec(`UPDATE positions SET pairAddress = 'Pool3333333333333333333333333333333333333333'`);
  const m = mockFetch((url) => (url.includes('/ohlcv/') ? { status: 200, body: { data: { attributes: { ohlcv_list: [] } } } } : { status: 200, body: poolBody('OtherQuote1111111111111111111111111111111111') }));
  try {
    const r = await positionChart(store, defaultConfig, 1, '5m', now);
    assert.equal(r.chart.unit, 'USD');
    assert.match(m.calls.find((u) => u.includes('/ohlcv/'))!, /currency=usd/);
    assert.match(m.calls.find((u) => u.includes('/ohlcv/'))!, /before_timestamp=/, 'closed trade asks for its own window');
    assert.equal(r.chart.candles.length, 0, 'no candles means none are invented');
  } finally {
    m.restore();
  }
});

test('provider rate limit is reported, not filled in', async () => {
  const store = new Store(':memory:');
  const now = Date.UTC(2026, 10, 16, 14, 0);
  seed(store, now - 600_000, null);
  store.db.exec(`UPDATE positions SET pairAddress = 'Pool2222222222222222222222222222222222222222'`);
  const m = mockFetch(() => ({ status: 429, body: { status: { error_code: 429 } } }));
  try {
    const r = await positionChart(store, defaultConfig, 1, '1m', now);
    assert.equal(r.chart.candles.length, 0);
    assert.equal(r.chart.error?.status, 429);
    await assert.rejects(positionChart(store, defaultConfig, 99, '1m', now), (e) => e instanceof ChartError && e.status === 404);
  } finally {
    m.restore();
  }
});
