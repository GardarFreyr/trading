import { resolve } from 'node:path';
import { loadConfig, ROOT, onRailway, listenHost, storageProblem } from './config.ts';
import { Store } from './db.ts';
import { Engine } from './engine.ts';
import { liveFeeds } from './live.ts';
import { startApi } from './api.ts';
import { applyPendingImport } from './dbimport.ts';
import { newOwnerId, readLease } from './lease.ts';

const cfg = loadConfig();
const dbFile = resolve(ROOT, cfg.dbPath);

const problem = storageProblem(dbFile);
if (problem) {
  console.error(`FATAL: ${problem}`);
  process.exit(1);
}

// A database uploaded through /api/admin/import is swapped in here, before anything opens it.
const imported = applyPendingImport(dbFile);
if (imported) console.log(imported);

const store = new Store(dbFile);
if (imported) store.event(imported.startsWith('Imported') ? 'info' : 'error', imported);

const label = onRailway() ? `railway:${process.env.RAILWAY_ENVIRONMENT_NAME ?? 'env'}` : 'local';
const owner = newOwnerId();
const engine = new Engine(cfg, store, liveFeeds(cfg));
engine.useLease(owner, label);
const host = listenHost();
const server = startApi(engine, cfg.port, { host, dbFile, restart: () => shutdown(75) });
engine.start();

const exp = store.experiment();
const lease = readLease(store);
console.log(`
  Solana Paper Trader — SIMULATION ONLY (no wallet, no keys, no real trades)
  Listening:  http://${host}:${cfg.port}  (${label})
  Database:   ${dbFile}
  Experiment: ${exp ? `#${exp.id} ${exp.status}, ends ${new Date(exp.endsAt).toISOString()}` : 'none yet'}
  Engine id:  ${owner}${lease && lease.owner !== owner ? `  (lease currently held by ${lease.owner})` : ''}
  Stop with Ctrl+C. State is persisted; restarting resumes the experiment.
`);

let stopping = false;
const shutdown = (code = 0) => {
  if (stopping) return;
  stopping = true;
  engine.stop();
  server.close();
  store.event('info', 'Engine stopped');
  store.close();
  process.exit(code);
};
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`${sig} received: stopping engine and releasing the trading lease`);
    shutdown();
  });
}
process.on('unhandledRejection', (e) => store.event('error', `Unhandled: ${(e as Error)?.message ?? e}`));
