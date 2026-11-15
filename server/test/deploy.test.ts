process.env.NO_REPORT_FILES = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { Engine, startExperiment } from '../src/engine.ts';
import { claimLease, LEASE_TTL_MS, readLease } from '../src/lease.ts';
import { applyPendingImport, inspectDb } from '../src/dbimport.ts';
import { FakeWorld } from './fixtures.ts';

const T0 = Date.UTC(2026, 10, 16, 8, 0, 0);
const cfg: Config = { ...defaultConfig, failureProbability: 0, latencySlippageStdBps: 0 };
const tmp = () => mkdtempSync(join(tmpdir(), 'deploy-'));

test('lease: only one engine trades a database; a stale lease can be taken over', async () => {
  const dir = tmp();
  try {
    const file = join(dir, 'db.sqlite');
    const clock = { t: T0 };
    const world = new FakeWorld(() => clock.t);
    world.prices.set('TOKA', 1);
    const storeA = new Store(file);
    const storeB = new Store(file);
    await startExperiment(storeA, cfg, world, clock.t);
    const a = new Engine(cfg, storeA, world, () => clock.t, () => 0.5);
    const b = new Engine(cfg, storeB, world, () => clock.t, () => 0.5);
    a.useLease('A', 'local');
    b.useLease('B', 'railway');

    await a.tick();
    const quotes = world.quotes;
    await b.tick();
    assert.equal(b.status, 'STANDBY');
    assert.equal(world.quotes, quotes, 'standby engine requests nothing');
    assert.equal(readLease(storeB)!.owner, 'A');

    // A keeps renewing: B stays out.
    clock.t += LEASE_TTL_MS - 1000;
    await a.tick();
    clock.t += 5000;
    await b.tick();
    assert.equal(b.status, 'STANDBY');

    // A dies without releasing: after the TTL, B takes over; A then stands by.
    clock.t += LEASE_TTL_MS + 1000;
    await b.tick();
    assert.notEqual(b.status, 'STANDBY');
    assert.equal(readLease(storeA)!.owner, 'B');
    await a.tick();
    assert.equal(a.status, 'STANDBY');

    // Clean stop releases immediately.
    b.stop();
    assert.equal(readLease(storeA), null);
    assert.equal(claimLease(storeA, 'C', 'x', clock.t).held, true);
    storeA.close();
    storeB.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function experimentDb(file: string) {
  const clock = { t: T0 };
  const world = new FakeWorld(() => clock.t);
  world.prices.set('TOKA', 1);
  const s = new Store(file);
  await startExperiment(s, cfg, world, clock.t);
  const e = new Engine(cfg, s, world, () => clock.t, () => 0.5);
  for (let i = 0; i < 8; i++) {
    world.prices.set('TOKA', world.prices.get('TOKA')! * 1.003);
    await e.tick();
    clock.t += 60_000;
  }
  const snap = { exp: s.experiment(), trades: s.trades(s.experiment()!.id), open: s.openPositions(s.experiment()!.id) };
  return { s, snap };
}

test('import: a snapshot replaces an empty deployment database exactly, keeping the old file', async () => {
  const dir = tmp();
  try {
    const src = join(dir, 'local.db');
    const { s, snap } = await experimentDb(src);
    assert.ok(snap.trades.length >= 1 && snap.open.length === 1);
    const out = join(dir, 'export.db');
    s.db.prepare('VACUUM INTO ?').run(out);
    s.close();

    const live = join(dir, 'vol', 'paper-trader.db');
    new Store(live).close(); // fresh deployment: schema only, no experiment
    const { renameSync } = await import('node:fs');
    renameSync(out, `${live}.import`);
    assert.match(applyPendingImport(live)!, /^Imported database: 1 experiment/);

    const after = new Store(live);
    assert.deepEqual(after.experiment(), snap.exp);
    assert.deepEqual(after.trades(snap.exp!.id), snap.trades);
    assert.deepEqual(after.openPositions(snap.exp!.id), snap.open);
    after.close();
    assert.ok(readdirSync(join(dir, 'vol')).some((f) => f.includes('.pre-import-')), 'old empty db kept as backup');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('import: never overwrites a database that already holds an experiment, and rejects junk', async () => {
  const dir = tmp();
  try {
    const live = join(dir, 'live.db');
    const { s, snap } = await experimentDb(live);
    s.close();
    const other = join(dir, 'other.db');
    const o = await experimentDb(other);
    o.s.close();
    const { copyFileSync } = await import('node:fs');
    copyFileSync(other, `${live}.import`);
    assert.match(applyPendingImport(live)!, /refused/);
    const still = new Store(live);
    assert.deepEqual(still.experiment(), snap.exp);
    still.close();
    assert.ok(readdirSync(dir).some((f) => f.includes('.import.rejected-')), 'rejected upload kept, not deleted');

    writeFileSync(`${live}.import`, 'not a database');
    assert.match(applyPendingImport(live)!, /rejected/);
    assert.equal(inspectDb(join(dir, 'missing.db')).ok, false);
    assert.ok(existsSync(live));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
