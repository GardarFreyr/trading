import { resolve } from 'node:path';
import { existsSync, renameSync, statSync } from 'node:fs';
import { readLease, LEASE_TTL_MS } from './lease.ts';
import { inspectDb } from './dbimport.ts';
import { loadConfig, ROOT } from './config.ts';
import { Store } from './db.ts';
import { startExperiment } from './engine.ts';
import { liveFeeds } from './live.ts';
import { buildReport, writeReport } from './report.ts';

const cfg = loadConfig();
const dbFile = resolve(ROOT, cfg.dbPath);
const cmd = process.argv[2];

async function main() {
  if (cmd === 'reset') {
    if (!existsSync(dbFile)) return console.log('Nothing to reset.');
    const backup = `${dbFile}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
    renameSync(dbFile, backup);
    for (const ext of ['-wal', '-shm']) if (existsSync(dbFile + ext)) renameSync(dbFile + ext, backup + ext);
    return console.log(`Database moved to ${backup}. Restart the engine, then start a new experiment.`);
  }
  if (cmd === 'export') {
    // Consistent single-file snapshot for migrating to another host. Requires the engine to be stopped,
    // so the snapshot is final and no second engine keeps trading the same experiment.
    const out = resolve(process.argv[3] ?? `paper-trader-export-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    if (existsSync(out)) throw new Error(`${out} already exists; choose another name`);
    if (!existsSync(dbFile)) throw new Error(`no database at ${dbFile}`);
    const store = new Store(dbFile);
    try {
      const lease = readLease(store);
      if (lease && Date.now() - lease.heartbeat < LEASE_TTL_MS) throw new Error(`engine ${lease.owner} is still running; stop it first`);
      const last = store.db.prepare("SELECT message FROM events WHERE message IN ('Engine started (paper trading only — no wallet, no real orders)','Engine stopped') ORDER BY id DESC LIMIT 1").get() as { message: string } | undefined;
      if (last && last.message !== 'Engine stopped') throw new Error('the engine is still running (or crashed without a clean stop); stop it with Ctrl+C first');
      store.db.prepare('VACUUM INTO ?').run(out);
    } finally {
      store.close();
    }
    const info = inspectDb(out);
    if (!info.ok) throw new Error(`export failed verification: ${info.error}`);
    console.log(`Exported ${out} (${(statSync(out).size / 1e6).toFixed(1)} MB): ${info.experiments} experiment(s), ${info.trades} trades, ${info.equityPoints} equity points. Original left untouched.`);
    return;
  }
  const store = new Store(dbFile);
  if (cmd === 'start') {
    const kind = process.argv[3] === 'continuous' ? 'continuous' : 'seven_day';
    const id = await startExperiment(store, cfg, liveFeeds(cfg), Date.now(), kind);
    const e = store.experimentById(id)!;
    console.log(`Experiment #${id} (${kind}) started: ${e.initialIsk} ISK${kind === 'continuous' ? ', no end date' : `, ends ${new Date(e.endsAt).toString()}`}`);
    console.log('Keep `npm start` running for the full seven days (the engine picks this up within one tick).');
  } else if (cmd === 'status' || cmd === 'report') {
    const e = process.argv[3] ? store.experimentById(Number(process.argv[3])) : store.experiment();
    if (!e) return console.log('No such experiment. Run `npm run experiment:start`.');
    const r = buildReport(store, e.id, Date.now(), cfg);
    if (cmd === 'report') {
      const files = writeReport(r, e.status === 'finished' ? `experiment-${e.id}-final` : `experiment-${e.id}-interim`);
      console.log(`Report written:\n  ${files.md}\n  ${files.json}`);
    }
    console.log(
      `#${e.id} ${e.status} · equity ${r.finalEquityIsk.toFixed(0)} ISK (${r.returnPct.toFixed(2)}%) · SOL hold ${r.solHoldReturnPct.toFixed(2)}% · ` +
        `${r.trades.completed} trades · win ${(r.trades.winRate * 100).toFixed(0)}% · costs ${r.costs.totalIsk.toFixed(0)} ISK`,
    );
  } else {
    console.log('Usage: cli.ts start [continuous] | status [id] | report [id] | reset | export [file]');
  }
  store.close();
}

main().catch((e) => {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
});
