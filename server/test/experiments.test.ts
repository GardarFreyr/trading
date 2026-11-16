process.env.NO_REPORT_FILES = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { Engine, startExperiment } from '../src/engine.ts';
import { rulesFor } from '../src/risk.ts';
import { stateSnapshot } from '../src/api.ts';
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
type S = ReturnType<typeof setup>;

async function warmUp(s: S, n: number, tokens: string[]) {
  for (let i = 0; i < n; i++) {
    for (const a of tokens) s.world.prices.set(a, s.world.prices.get(a)! * 1.003);
    await s.engine.tick();
    s.clock.t += MIN;
  }
}

/** Each experiment's cash must reconcile with ITS OWN trades and positions only. */
function assertBooksBalance(s: S, expId: number) {
  const exp = s.store.experimentById(expId)!;
  const closed = s.store.closedPositions(exp.id).reduce((a, p) => a + p.netPnlIsk!, 0);
  const open = s.store.openPositions(exp.id).reduce((a, p) => a + p.costIsk + p.extraFeesIsk, 0);
  const failedBuys = s.store.trades(exp.id).filter((t) => t.side === 'BUY' && t.status === 'FAILED').reduce((a, t) => a + t.feeIsk, 0);
  assert.ok(Math.abs(exp.cashIsk - (exp.initialIsk + closed - failedBuys - open)) < 1e-6, `books balance for #${expId}`);
}

async function startBoth(s: S) {
  const seven = await startExperiment(s.store, s.cfg, s.world, s.clock.t);
  const cont = await startExperiment(s.store, s.cfg, s.world, s.clock.t, 'continuous');
  return { seven, cont };
}

test('experiments: a continuous experiment runs alongside the seven-day one on completely separate books', async () => {
  const s = setup();
  for (const a of ['TOKA', 'TOKB', 'TOKC']) s.world.prices.set(a, 1);
  const { seven, cont } = await startBoth(s);
  assert.notEqual(seven, cont);
  await assert.rejects(startExperiment(s.store, s.cfg, s.world, s.clock.t, 'continuous'), /already running/);
  await assert.rejects(startExperiment(s.store, s.cfg, s.world, s.clock.t, 'seven_day'), /already running/);

  const c = s.store.experimentById(cont)!;
  assert.equal(c.kind, 'continuous');
  assert.equal(c.cashIsk, 10_000);
  assert.deepEqual(rulesFor(c, s.cfg), { kind: 'continuous', dailyLossLimitIsk: null, maxDrawdownPct: 0.2, endsAt: null });
  assert.deepEqual(rulesFor(s.store.experimentById(seven)!, s.cfg).dailyLossLimitIsk, 350);
  assert.equal(rulesFor(s.store.experimentById(seven)!, s.cfg).maxDrawdownPct, null);

  await warmUp(s, 12, ['TOKA', 'TOKB', 'TOKC']);
  for (const id of [seven, cont]) {
    const open = s.store.openPositions(id);
    assert.equal(open.length, 2, `#${id} holds max 2`);
    assert.ok(open.every((p) => p.experimentId === id && p.costIsk <= 700 + 1e-9));
    assert.ok(s.store.trades(id).every((t) => t.experimentId === id));
    assertBooksBalance(s, id);
  }
  // Same market, same rules → each experiment spent exactly its own money.
  const spent = (id: number) => 10_000 - s.store.experimentById(id)!.cashIsk;
  assert.ok(spent(seven) > 1300 && spent(seven) <= 1400 + 1e-9);
  assert.ok(Math.abs(spent(seven) - spent(cont)) < 1e-6);

  // Take profit on TOKA closes it in BOTH experiments, but each books its own proceeds.
  s.world.prices.set('TOKA', s.world.prices.get('TOKA')! * 1.25);
  await s.engine.tick();
  for (const id of [seven, cont]) {
    assert.equal(s.store.closedPositions(id).length, 1);
    assert.equal(s.store.closedPositions(id)[0].exitKind, 'TAKE_PROFIT');
    assertBooksBalance(s, id);
  }

  // The API shows one experiment at a time, with only its own positions and events.
  const snap = stateSnapshot(s.engine, cont);
  assert.equal(snap.experiment!.id, cont);
  assert.equal(snap.experiment!.kind, 'continuous');
  assert.equal(snap.experiment!.endsAt, null);
  assert.equal(snap.config.dailyLossLimitIsk, null);
  assert.equal(snap.config.maxDrawdownPct, 0.2);
  assert.ok(snap.experiment!.openPositions.every((p) => p.experimentId === cont));
  assert.ok(snap.events.every((e) => e.experimentId == null || e.experimentId === cont));
  const def = stateSnapshot(s.engine);
  assert.equal(def.experiment!.id, seven, 'default view stays on the seven-day experiment while it runs');
  assert.equal(def.config.dailyLossLimitIsk, 350);
  assert.equal(def.experiments.length, 2);
});

test('experiments: the continuous experiment has no daily loss halt but still records daily P/L; the seven-day one still halts', async () => {
  const s = setup();
  s.world.prices.set('TOKA', 1);
  s.world.prices.set('TOKB', 1);
  const { seven, cont } = await startBoth(s);
  await warmUp(s, 9, ['TOKA', 'TOKB']);
  assert.equal(s.store.openPositions(seven).length, 2);
  assert.equal(s.store.openPositions(cont).length, 2);

  // Both crash 30%: stop losses in both; day loss > 350 in both.
  s.world.prices.set('TOKA', s.world.prices.get('TOKA')! * 0.7);
  s.world.prices.set('TOKB', s.world.prices.get('TOKB')! * 0.7);
  await s.engine.tick();
  for (const id of [seven, cont]) {
    assert.ok(s.store.closedPositions(id).every((p) => p.exitKind === 'STOP_LOSS'));
    assert.ok(s.store.closedPositions(id).reduce((a, p) => a + p.netPnlIsk!, 0) < -350);
  }

  s.world.prices.delete('TOKA');
  s.world.prices.delete('TOKB');
  s.world.prices.set('TOKC', 1);
  s.clock.t += MIN;
  await warmUp(s, 10, ['TOKC']);

  assert.equal(s.engine.statusOf(seven).status, 'HALTED_DAILY_LOSS');
  assert.equal(s.store.openPositions(seven).length, 0, 'seven-day: no new entries today (unchanged rule)');
  assert.equal(s.engine.statusOf(cont).status, 'RUNNING');
  assert.equal(s.store.openPositions(cont).length, 1, 'continuous: keeps trading the same day');
  assert.equal(s.store.openPositions(cont)[0].tokenAddress, 'TOKC');
  assert.equal(s.engine.status, 'HALTED_DAILY_LOSS', 'engine-wide status follows the seven-day experiment');

  // Daily loss, drawdown and costs are still recorded for the continuous experiment.
  const snap = stateSnapshot(s.engine, cont).experiment!;
  assert.ok(snap.dailyPnlIsk < -350 && snap.dailyLossUsedIsk > 350);
  assert.ok(snap.drawdown.pct > 0.035);
  assert.ok(snap.currentDrawdownPct > 3.5);
  assert.ok(snap.costs.feesIsk > 0 && snap.costs.slippageIsk > 0);
  assert.equal(s.store.dayStarts(cont).length, 1);
  assertBooksBalance(s, seven);
  assertBooksBalance(s, cont);
});

test('experiments: the 20% drawdown halt liquidates and permanently stops only the continuous experiment', async () => {
  // Smaller bankroll so two 700 ISK positions can reach a 20% drawdown (400 ISK).
  const s = setup({ initialCapitalIsk: 2000 });
  s.world.prices.set('TOKA', 1);
  s.world.prices.set('TOKB', 1);
  const { seven, cont } = await startBoth(s);
  await warmUp(s, 9, ['TOKA', 'TOKB']);
  const [a, b] = s.store.openPositions(cont);
  assert.ok(a && b);

  // A: −60% (stop loss). B: −8% (no exit rule of its own) → must be force-closed by the halt.
  s.world.prices.set(a.tokenAddress, s.world.prices.get(a.tokenAddress)! * 0.4);
  s.world.prices.set(b.tokenAddress, s.world.prices.get(b.tokenAddress)! * 0.92);
  await s.engine.tick();

  const c = s.store.experimentById(cont)!;
  assert.equal(c.status, 'halted');
  assert.ok(c.haltedAt);
  assert.match(c.haltReason!, /Drawdown halt: .* below its peak .* \(limit 20%\)/);
  assert.equal(s.store.openPositions(cont).length, 0);
  const kinds = s.store.closedPositions(cont).map((p) => p.exitKind).sort();
  assert.deepEqual(kinds, ['DRAWDOWN_HALT', 'STOP_LOSS']);
  assert.ok(c.reportJson, 'final report saved');
  assert.equal(JSON.parse(c.reportJson!).kind, 'continuous');
  assert.equal(s.engine.statusOf(cont).status, 'HALTED_DRAWDOWN');
  assertBooksBalance(s, cont);

  // Seven-day experiment: no drawdown halt; it follows its own (daily loss) rules and keeps running.
  const sv = s.store.experimentById(seven)!;
  assert.equal(sv.status, 'running');
  assert.equal(sv.haltedAt, null);
  assert.equal(sv.peakEquityIsk, null, 'seven-day row is not touched by drawdown tracking');
  assert.ok(!s.store.closedPositions(seven).some((p) => p.exitKind === 'DRAWDOWN_HALT'));

  // The halted experiment never trades again, even on a perfect new candidate on a later day.
  const buys = s.store.trades(cont).length;
  s.world.prices.set('TOKC', 1);
  s.clock.t = Date.UTC(2026, 10, 17, 0, 1, 0);
  await warmUp(s, 10, ['TOKC']);
  assert.equal(s.store.trades(cont).length, buys);
  assert.equal(s.store.experimentById(cont)!.status, 'halted');
  assert.ok(s.store.openPositions(seven).length >= 1, 'seven-day resumes on the new UTC day');
  assertBooksBalance(s, seven);
});

test('experiments: drawdown is measured from the equity peak, not the starting capital', async () => {
  const s = setup({ initialCapitalIsk: 2000 });
  s.world.prices.set('TOKA', 1);
  const cont = await startExperiment(s.store, s.cfg, s.world, s.clock.t, 'continuous');
  await warmUp(s, 8, ['TOKA']);
  // +15%: below the 20% TP and above the 12% trailing trigger, so it stays open and lifts the peak.
  s.world.prices.set('TOKA', s.world.prices.get('TOKA')! * 1.15);
  await s.engine.tick();
  const peak = s.store.experimentById(cont)!.peakEquityIsk!;
  assert.ok(peak > 2050, `peak ${peak}`);
  assert.equal(s.store.experimentById(cont)!.status, 'running');
});

test('experiments: re-entry cooldown is per experiment', async () => {
  const s = setup();
  const t0 = s.clock.t;
  const a = await startExperiment(s.store, s.cfg, s.world, t0);
  const b = await startExperiment(s.store, s.cfg, s.world, t0, 'continuous');
  const pos = {
    tokenAddress: 'TOKA', symbol: 'A', pairAddress: 'p', decimals: 6, status: 'closed' as const, openedAt: t0, closedAt: t0 + MIN,
    tokenAmount: 1, solIn: 1, costIsk: 1, entryPriceSol: 1, entryMarkSol: 1, peakPriceSol: 1, lastMarkSol: 1, entryReason: 'x',
    exitReason: 'x', exitKind: 'STOP_LOSS', proceedsIsk: 1, extraFeesIsk: 0, netPnlIsk: 0, exitAttempts: 1,
  };
  s.store.insertPosition({ ...pos, experimentId: a });
  assert.equal(s.store.lastExitAt(a, 'TOKA'), t0 + MIN);
  assert.equal(s.store.lastExitAt(b, 'TOKA'), null, "experiment #1's exit does not block experiment #2");
});

/** The pre-change schema, exactly as experiment #1's database was created. */
const OLD_EXPERIMENT_DDL = `
CREATE TABLE experiment (id INTEGER PRIMARY KEY AUTOINCREMENT, startedAt INTEGER NOT NULL, endsAt INTEGER NOT NULL,
  initialIsk REAL NOT NULL, cashIsk REAL NOT NULL, status TEXT NOT NULL, solUsdStart REAL NOT NULL, iskPerUsdStart REAL NOT NULL,
  finishedAt INTEGER, reportJson TEXT);
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL);`;

test('migration: an existing seven-day database gains the new columns with every existing value unchanged, after a backup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paper-mig-'));
  const file = join(dir, 'db.sqlite');
  try {
    const t0 = Date.UTC(2026, 10, 15, 12, 0, 0);
    const raw = new DatabaseSync(file);
    raw.exec(OLD_EXPERIMENT_DDL);
    raw.prepare('INSERT INTO experiment (startedAt, endsAt, initialIsk, cashIsk, status, solUsdStart, iskPerUsdStart) VALUES (?,?,?,?,?,?,?)').run(t0, t0 + 7 * 86_400_000, 10_000, 9123.45, 'running', 140, 125);
    raw.prepare('INSERT INTO events (ts, level, message) VALUES (?,?,?)').run(t0, 'info', 'old event');
    const before = raw.prepare('SELECT * FROM experiment').get();
    raw.close();

    const store = new Store(file);
    assert.deepEqual(store.migrated.sort(), ['events.experimentId', 'experiment.haltReason', 'experiment.haltedAt', 'experiment.kind', 'experiment.maxDrawdownPct', 'experiment.peakEquityIsk']);
    assert.ok(store.migrationBackup && readdirSync(dir).some((f) => f.includes('.pre-migration-')), 'backup copy taken');
    const after = store.experimentById(1)!;
    for (const [k, v] of Object.entries(before as object)) assert.deepEqual((after as unknown as Record<string, unknown>)[k], v, `column ${k} unchanged`);
    assert.equal(after.kind, 'seven_day');
    assert.equal(after.maxDrawdownPct, null);
    assert.deepEqual(rulesFor(after, defaultConfig), { kind: 'seven_day', dailyLossLimitIsk: 350, maxDrawdownPct: null, endsAt: t0 + 7 * 86_400_000 });
    assert.equal(store.events(10)[0].message, 'old event');
    store.close();

    // Re-opening is a no-op (no second backup, nothing re-added).
    const again = new Store(file);
    assert.deepEqual(again.migrated, []);
    assert.equal(readdirSync(dir).filter((f) => f.includes('.pre-migration-')).length, 1);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
