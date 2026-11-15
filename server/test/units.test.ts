import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../src/config.ts';
import { simulateSwap, modelQuote, networkFeeSol } from '../src/execution.ts';
import type { SimQuote } from '../src/execution.ts';
import { canOpenPosition, positionSizeIsk, dailyLossLimitHit } from '../src/risk.ts';
import type { RiskContext } from '../src/risk.ts';
import { filterToken, checkExit, scoreMomentum } from '../src/strategy.ts';
import { maxDrawdown, tradeStats, buyCostIsk, sellProceedsIsk } from '../src/accounting.ts';
import { toRaw } from '../src/engine.ts';
import { market } from './fixtures.ts';

const cfg = defaultConfig;
const seq = (...xs: number[]) => {
  let i = 0;
  return () => (i < xs.length ? xs[i++] : 0.5);
};
const q = (outAmount: number, priceImpactPct = 0.5): SimQuote => ({ outAmount, priceImpactPct, source: 'jupiter', route: 'test' });

// ---------- Execution ----------

test('execution: buy never fills at the displayed price; latency drift is adverse', () => {
  const mark = 0.001; // SOL per token
  const quoteOut = (1 / mark) * 0.99; // quote already 1% worse than mark
  // gaussian(0.9, 0) → positive z → latency > mean
  const r = simulateSwap({ side: 'BUY', amountIn: 1, markPriceSol: mark, quote: q(quoteOut), rng: seq(0.3, 0, 0.9) }, cfg);
  assert.equal(r.status, 'FILLED');
  assert.ok(r.amountOut < quoteOut, 'latency reduces output');
  assert.ok(r.fillPriceSol! > mark, 'fill worse than mark');
  assert.ok(r.slippageVsMarkBps! > 100, 'includes quote spread + latency');
  assert.equal(r.feeSol, networkFeeSol(cfg));
});

test('execution: sell fills below mark', () => {
  const r = simulateSwap({ side: 'SELL', amountIn: 1000, markPriceSol: 0.001, quote: q(0.98), rng: seq(0.5, 0.5, 0.9) }, cfg);
  assert.equal(r.status, 'FILLED');
  assert.ok(r.fillPriceSol! < 0.001);
  assert.ok(r.slippageVsMarkBps! >= 200);
});

test('execution: random dropped transaction fails but still pays the network fee', () => {
  const r = simulateSwap({ side: 'BUY', amountIn: 1, markPriceSol: 0.001, quote: q(990), rng: seq(0.5, 0.5, 0.01) }, cfg);
  assert.equal(r.status, 'FAILED');
  assert.equal(r.amountOut, 0);
  assert.equal(r.fillPriceSol, null);
  assert.ok(r.feeSol > 0);
  assert.match(r.failReason!, /dropped/);
});

test('execution: latency beyond slippage tolerance fails the transaction', () => {
  // u tiny → |z| huge; v=0 → cos=1 → large positive drift
  // z ≈ +6.4 with std 100 bps → ~670 bps drift
  const r = simulateSwap({ side: 'BUY', amountIn: 1, markPriceSol: 0.001, quote: q(990), rng: seq(1e-9, 0, 0.99) }, { ...cfg, latencySlippageStdBps: 100 });
  assert.equal(r.status, 'FAILED');
  assert.match(r.failReason!, /tolerance/);
});

test('execution: modelled fallback quote is worse than mark on both sides and grows with size', () => {
  const small = modelQuote('BUY', 1, 0.001, 200_000, 100, cfg);
  const big = modelQuote('BUY', 50, 0.001, 200_000, 100, cfg);
  assert.ok(small.outAmount < 1 / 0.001);
  assert.ok(big.outAmount / 50 < small.outAmount / 1, 'larger size → worse average price');
  assert.ok(big.priceImpactPct > small.priceImpactPct);
  const sell = modelQuote('SELL', 1000, 0.001, 200_000, 100, cfg);
  assert.ok(sell.outAmount < 1);
});

test('toRaw converts UI amounts to integer base units without float blowups', () => {
  assert.equal(toRaw(1.5, 9), 1_500_000_000n);
  assert.equal(toRaw(123456789.123456, 6), 123456789123456n);
  assert.equal(toRaw(0, 6), 0n);
});

// ---------- Risk ----------

const ctx = (o: Partial<RiskContext> = {}): RiskContext => ({
  now: 1000, experimentStatus: 'running', endsAt: 2000, openPositions: 0, cashIsk: 10_000, dailyPnlIsk: 0, dataHealthy: true, ...o,
});

test('risk: allows an entry when every limit is satisfied', () => {
  assert.deepEqual(canOpenPosition(ctx(), cfg), { ok: true });
});

test('risk: max two open positions', () => {
  assert.equal(canOpenPosition(ctx({ openPositions: 1 }), cfg).ok, true);
  const d = canOpenPosition(ctx({ openPositions: 2 }), cfg);
  assert.equal(d.ok, false);
});

test('risk: daily loss limit of 350 ISK blocks entries (inclusive)', () => {
  assert.equal(canOpenPosition(ctx({ dailyPnlIsk: -349.99 }), cfg).ok, true);
  assert.equal(canOpenPosition(ctx({ dailyPnlIsk: -350 }), cfg).ok, false);
  assert.equal(dailyLossLimitHit(-351, cfg), true);
});

test('risk: stale data, ended window, missing experiment and low cash all block', () => {
  assert.equal(canOpenPosition(ctx({ dataHealthy: false }), cfg).ok, false);
  assert.equal(canOpenPosition(ctx({ now: 2000 }), cfg).ok, false);
  assert.equal(canOpenPosition(ctx({ experimentStatus: 'none' }), cfg).ok, false);
  assert.equal(canOpenPosition(ctx({ cashIsk: 50 }), cfg).ok, false);
});

test('risk: position size capped at 700 ISK and by available cash', () => {
  assert.equal(positionSizeIsk(10_000, cfg), 700);
  assert.equal(positionSizeIsk(450, cfg), 450);
  assert.equal(positionSizeIsk(-5, cfg), 0);
});

// ---------- Strategy ----------

test('filters: healthy token passes; illiquid / new / parabolic / honeypot-like tokens are rejected', () => {
  const now = Date.now();
  assert.equal(filterToken(market('A', 1, now), cfg, now).ok, true);
  assert.match(filterToken(market('A', 1, now, { liquidityUsd: 5_000 }), cfg, now).reasons.join(), /illiquid/);
  assert.match(filterToken(market('A', 1, now, { pairCreatedAt: now - 30 * 60_000 }), cfg, now).reasons.join(), /too new/);
  assert.match(filterToken(market('A', 1, now, { change: { m5: 5, h1: 400, h6: 0, h24: 0 } }), cfg, now).reasons.join(), /parabolic/);
  const hp = market('A', 1, now, { txns: { m5: { buys: 50, sells: 0 }, h1: { buys: 600, sells: 3 }, h24: { buys: 1, sells: 1 } } });
  assert.match(filterToken(hp, cfg, now).reasons.join(), /honeypot/);
});

test('exits: +20% take profit, −10% stop loss, trailing stop and time stop', () => {
  const p = { entryPriceSol: 1, peakPriceSol: 1, openedAt: 0 };
  assert.equal(checkExit(p, 1.2, 1, cfg)?.kind, 'TAKE_PROFIT');
  assert.equal(checkExit(p, 1.19, 1, cfg), null);
  assert.equal(checkExit(p, 0.9, 1, cfg)?.kind, 'STOP_LOSS');
  assert.equal(checkExit(p, 0.91, 1, cfg), null);
  assert.equal(checkExit({ ...p, peakPriceSol: 1.15 }, 1.06, 1, cfg)?.kind, 'TRAILING_STOP');
  assert.equal(checkExit({ ...p, peakPriceSol: 1.15 }, 1.08, 1, cfg), null);
  assert.equal(checkExit(p, 1.01, cfg.maxHoldMinutes * 60_000, cfg)?.kind, 'TIME_STOP');
});

test('scoring: requires our own forward observations before an entry is allowed', () => {
  const now = Date.now();
  const m = market('A', 1, now);
  assert.equal(scoreMomentum(m, [], now, cfg).ready, false);
  const hist = Array.from({ length: 7 }, (_, i) => ({ ts: now - (6 - i) * 60_000, priceUsd: 1 + i * 0.003 }));
  const s = scoreMomentum(m, hist, now, cfg);
  assert.equal(s.ready, true);
  assert.ok(s.score >= cfg.minEntryScore, `score ${s.score}`);
  const dumping = hist.map((h, i) => ({ ...h, priceUsd: 1 - i * 0.02 }));
  assert.equal(scoreMomentum(m, dumping, now, cfg).ready, false);
});

// ---------- Accounting ----------

test('accounting: max drawdown from peak', () => {
  const dd = maxDrawdown([10_000, 10_500, 9_975, 10_800, 10_200].map((equityIsk, ts) => ({ ts, equityIsk })));
  // 10,500→9,975 is −5%; 10,800→10,200 is −5.56%, the larger one
  assert.equal(dd.peakIsk, 10_800);
  assert.equal(Math.round(dd.isk), 600);
  assert.ok(Math.abs(dd.pct - 600 / 10_800) < 1e-9);
});

test('accounting: trade stats and win rate', () => {
  const s = tradeStats([{ netPnlIsk: 100 }, { netPnlIsk: -50 }, { netPnlIsk: -25 }, { netPnlIsk: 75 }]);
  assert.equal(s.completed, 4);
  assert.equal(s.winRate, 0.5);
  assert.equal(s.profitFactor, 175 / 75);
  assert.equal(s.netIsk, 100);
});

test('accounting: fees are added to buy cost and deducted from sell proceeds', () => {
  assert.ok(Math.abs(buyCostIsk(1, 0.001, 10_000) - 10_010) < 1e-9);
  assert.ok(Math.abs(sellProceedsIsk(1, 0.001, 10_000) - 9_990) < 1e-9);
});
