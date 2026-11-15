import { resolve } from 'node:path';
import { existsSync, renameSync } from 'node:fs';
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
  const store = new Store(dbFile);
  if (cmd === 'start') {
    const id = await startExperiment(store, cfg, liveFeeds(cfg));
    const e = store.experiment()!;
    console.log(`Experiment #${id} started: ${e.initialIsk} ISK, ends ${new Date(e.endsAt).toString()}`);
    console.log('Keep `npm start` running for the full seven days (the engine picks this up within one tick).');
  } else if (cmd === 'status' || cmd === 'report') {
    const e = store.experiment();
    if (!e) return console.log('No experiment yet. Run `npm run experiment:start`.');
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
    console.log('Usage: cli.ts start | status | report | reset');
  }
  store.close();
}

main().catch((e) => {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
});
