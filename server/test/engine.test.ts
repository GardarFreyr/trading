process.env.NO_REPORT_FILES = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { Engine, startExperiment } from '../src/engine.ts';
import { buildReport } from '../src/report.ts';
import { FakeWorld } from './fixtures.ts';

const MIN = 60_000;

function setup(over: Partial<Config> = {}, dbPath = ':memory:') {
  const clock = { t: Date.UTC(2026, 10, 16, 8, 0, 0) };
  const now = () => clock.t;
  const world = new FakeWorld(now);
  const cfg: Config = { ...defaultConfig, failureProbability: 0, latencySlippageStdBps: 0, ...over };
  const store = new Store(dbPath);
  const engine = new Engine(cfg, store, world, now, () => 0.5);
  return { clock, world, cfg, store, engine };
}

/** Tick once a minute while nudging prices up, until the engine has had `n` ticks. */
async function warmUp(s: ReturnType<typeof setup>, n: number, tokens: string[]) {
  for (let i = 0; i < n; i++) {
    for (const a of tokens) s.world.prices.set(a, s.world.prices.get(a)! * 1.003);
    await s.engine.tick();
    s.clock.t += MIN;
  }
}

/** Core accounting invariant: cash = initial + realised net P/L − fees of failed entries − cost of open positions − failed-exit fees on open positions. */
function assertBooksBalance(s: ReturnType<typeof setup>) {
  const exp = s.store.experiment()!;
  const closed = s.store.closedPositions(exp.id).reduce((a, p) => a + p.netPnlIsk!, 0);
  const open = s.store.openPositions(exp.id).reduce((a, p) => a + p.costIsk + p.extraFeesIsk, 0);
  const failedBuys = s.store.trades(exp.id).filter((t) => t.side === 'BUY' && t.status === 'FAILED').reduce((a, t) => a + t.feeIsk, 0);
  assert.ok(Math.abs(exp.cashIsk - (exp.initialIsk + closed - failedBuys - open)) < 1e-6, 'books balance');
}

test('engine: full round trip — observes, enters within limits, takes profit, books every cost', async () => {
  const s = setup();
  s.world.prices.set('TOKA', 1);
  await startExperiment(s.store, s.cfg, s.world, s.clock.t);
  assert.equal(s.store.experiment()!.cashIsk, 10_000);

  await warmUp(s, 3, ['TOKA']);
  const exp = s.store.experiment()!;
  assert.equal(s.store.openPositions(exp.id).length, 0, 'no entry before 5 min of own observations');

  await warmUp(s, 5, ['TOKA']);
  const [pos] = s.store.openPositions(exp.id);
  assert.ok(pos, 'entered after observation window');
  assert.ok(pos.costIsk <= 700 + 1e-9 && pos.costIsk > 699, `cost ${pos.costIsk}`);
  assert.ok(pos.entryPriceSol > pos.entryMarkSol, 'filled worse than displayed price');
  assert.match(pos.entryReason, /Momentum score/);
  const buy = s.store.trades(exp.id)[0];
  assert.equal(buy.side, 'BUY');
  assert.equal(buy.status, 'FILLED');
  assert.ok(buy.slippageIsk > 0 && buy.feeIsk > 0);
  assertBooksBalance(s);

  // +25% → take profit at a realistic (quoted, worse-than-mark) price
  s.world.prices.set('TOKA', s.world.prices.get('TOKA')! * 1.25);
  await s.engine.tick();
  const [closed] = s.store.closedPositions(exp.id);
  assert.equal(closed.exitKind, 'TAKE_PROFIT');
  assert.ok(closed.netPnlIsk! > 0 && closed.netPnlIsk! < 0.25 * 700, 'profit is below the gross move after costs');
  assertBooksBalance(s);

  const r = buildReport(s.store, exp.id, s.clock.t, s.cfg);
  assert.equal(r.trades.completed, 1);
  assert.equal(r.trades.winRate, 1);
  assert.ok(r.costs.totalIsk > 0);
});

test('engine: never more than two open positions', async () => {
  const s = setup();
  for (const a of ['TOKA', 'TOKB', 'TOKC', 'TOKD']) s.world.prices.set(a, 1);
  await startExperiment(s.store, s.cfg, s.world, s.clock.t);
  await warmUp(s, 12, ['TOKA', 'TOKB', 'TOKC', 'TOKD']);
  const exp = s.store.experiment()!;
  assert.equal(s.store.openPositions(exp.id).length, 2);
  assert.equal(s.store.trades(exp.id).filter((t) => t.side === 'BUY').length, 2);
  assertBooksBalance(s);
});

test('engine: stop loss and the 350 ISK daily loss limit halt new entries until the next UTC day', async () => {
  const s = setup();
  s.world.prices.set('TOKA', 1);
  s.world.prices.set('TOKB', 1);
  await startExperiment(s.store, s.cfg, s.world, s.clock.t);
  await warmUp(s, 9, ['TOKA', 'TOKB']);
  const exp = s.store.experiment()!;
  assert.equal(s.store.openPositions(exp.id).length, 2);

  // Gap down 30% on both: stop losses fire (filled at the gapped price, not at −10%)
  s.world.prices.set('TOKA', s.world.prices.get('TOKA')! * 0.7);
  s.world.prices.set('TOKB', s.world.prices.get('TOKB')! * 0.7);
  await s.engine.tick();
  const closed = s.store.closedPositions(exp.id);
  assert.equal(closed.length, 2);
  assert.ok(closed.every((p) => p.exitKind === 'STOP_LOSS'));
  assert.ok(closed.reduce((a, p) => a + p.netPnlIsk!, 0) < -350);
  assertBooksBalance(s);

  // The crashed tokens get delisted; a fresh, perfect candidate appears — must NOT be bought today.
  s.world.prices.delete('TOKA');
  s.world.prices.delete('TOKB');
  s.world.prices.set('TOKC', 1);
  s.clock.t += MIN;
  await warmUp(s, 10, ['TOKC']);
  assert.equal(s.engine.status, 'HALTED_DAILY_LOSS');
  assert.equal(s.store.openPositions(exp.id).length, 0);

  // Next UTC day: trading resumes.
  s.clock.t = Date.UTC(2026, 10, 17, 0, 1, 0);
  await warmUp(s, 8, ['TOKC']);
  assert.equal(s.store.openPositions(exp.id).length, 1);
  assert.equal(s.store.openPositions(exp.id)[0].tokenAddress, 'TOKC');
});

test('engine: records equity points on a real clock that advances during a tick', async () => {
  const s = setup();
  let t = s.clock.t;
  const ticking = () => (t += 7); // every read of the clock advances a few ms, like Date.now()
  const engine = new Engine(s.cfg, s.store, new FakeWorld(ticking), ticking, () => 0.5);
  await startExperiment(s.store, s.cfg, engine.feeds, t);
  for (let i = 0; i < 3; i++) {
    t += MIN;
    await engine.tick();
  }
  assert.ok(s.store.equity(s.store.experiment()!.id).length >= 3);
});

test('engine: pauses on stale or unavailable data and never trades on it', async () => {
  const s = setup();
  s.world.prices.set('TOKA', 1);
  await startExperiment(s.store, s.cfg, s.world, s.clock.t);
  await warmUp(s, 3, ['TOKA']);
  s.world.down = true;
  const quotesBefore = s.world.quotes;
  const equityBefore = s.store.equity(s.store.experiment()!.id).length;
  await warmUp(s, 10, ['TOKA']);
  assert.equal(s.engine.status, 'PAUSED_STALE_DATA');
  assert.equal(s.world.quotes, quotesBefore, 'no quotes requested while paused');
  assert.equal(s.store.trades(s.store.experiment()!.id).length, 0);
  assert.equal(s.store.equity(s.store.experiment()!.id).length, equityBefore, 'no equity points fabricated while data is stale');

  s.world.down = false;
  await warmUp(s, 2, ['TOKA']);
  assert.notEqual(s.engine.status, 'PAUSED_STALE_DATA');
});

test('engine: failed simulated transactions cost the network fee and open nothing', async () => {
  const s = setup({ failureProbability: 1 });
  s.world.prices.set('TOKA', 1);
  await startExperiment(s.store, s.cfg, s.world, s.clock.t);
  await warmUp(s, 8, ['TOKA']);
  const exp = s.store.experiment()!;
  const trades = s.store.trades(exp.id);
  assert.ok(trades.length >= 1);
  assert.ok(trades.every((t) => t.status === 'FAILED'));
  assert.equal(s.store.openPositions(exp.id).length, 0);
  assert.ok(exp.cashIsk < 10_000 && exp.cashIsk > 10_000 - trades.length * 3);
  assertBooksBalance(s);
});

test('engine: rejects tokens whose round-trip quote reveals a large tax / thin route', async () => {
  const s = setup();
  s.world.prices.set('TOKA', 1);
  s.world.quoteHaircut = 0.05; // ~10% round trip
  await startExperiment(s.store, s.cfg, s.world, s.clock.t);
  await warmUp(s, 8, ['TOKA']);
  const exp = s.store.experiment()!;
  assert.equal(s.store.trades(exp.id).length, 0);
  assert.match(s.store.token('TOKA')!.rejectReason!, /round-trip/);
});

test('engine: state survives a restart and the experiment continues', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paper-'));
  const file = join(dir, 'db.sqlite');
  try {
    const s = setup({}, file);
    s.world.prices.set('TOKA', 1);
    await startExperiment(s.store, s.cfg, s.world, s.clock.t);
    await warmUp(s, 8, ['TOKA']);
    const before = s.store.openPositions(s.store.experiment()!.id)[0];
    assert.ok(before);
    s.store.close();

    // "Restart": brand-new store + engine on the same file.
    const store2 = new Store(file);
    const engine2 = new Engine(s.cfg, store2, s.world, () => s.clock.t, () => 0.5);
    const after = store2.openPositions(store2.experiment()!.id)[0];
    assert.deepEqual(after, before);
    s.world.prices.set('TOKA', s.world.prices.get('TOKA')! * 1.3);
    await engine2.tick();
    assert.equal(store2.closedPositions(store2.experiment()!.id)[0].exitKind, 'TAKE_PROFIT');
    store2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('engine: at the end of seven days positions are liquidated and a final report compares against holding SOL', async () => {
  const s = setup();
  s.world.prices.set('TOKA', 1);
  await startExperiment(s.store, s.cfg, s.world, s.clock.t);
  await assert.rejects(startExperiment(s.store, s.cfg, s.world, s.clock.t), /already running/);
  await warmUp(s, 8, ['TOKA']);
  const exp = s.store.experiment()!;
  assert.equal(s.store.openPositions(exp.id).length, 1);

  s.world.solUsd = 110; // SOL +10% during the week
  s.clock.t = exp.endsAt + MIN;
  await s.engine.tick();
  const done = s.store.experiment()!;
  assert.equal(done.status, 'finished');
  assert.equal(s.store.openPositions(exp.id).length, 0);
  assert.equal(s.store.closedPositions(exp.id)[0].exitKind, 'EXPERIMENT_END');
  const r = JSON.parse(done.reportJson!);
  assert.ok(Math.abs(r.solHoldReturnPct - 10) < 1e-6);
  assert.ok(Math.abs(r.excessVsSolPct - (r.returnPct - r.solHoldReturnPct)) < 1e-9);
  assert.match(r.disclaimer, /SIMULATED/);
  assertBooksBalance(s);

  // No trading after the window.
  await warmUp(s, 8, ['TOKA']);
  assert.equal(s.store.trades(exp.id).filter((t) => t.side === 'BUY').length, 1);
});
