import { resolve } from 'node:path';
import { loadConfig, ROOT } from './config.ts';
import { Store } from './db.ts';
import { Engine } from './engine.ts';
import { liveFeeds } from './live.ts';
import { startApi } from './api.ts';

const cfg = loadConfig();
const store = new Store(resolve(ROOT, cfg.dbPath));
const engine = new Engine(cfg, store, liveFeeds(cfg));
const server = startApi(engine, cfg.port);
engine.start();

console.log(`
  Solana Paper Trader — SIMULATION ONLY (no wallet, no keys, no real trades)
  Dashboard:  http://localhost:${cfg.port}
  Database:   ${resolve(ROOT, cfg.dbPath)}
  Stop with Ctrl+C. State is persisted; restarting resumes the experiment.
`);

const shutdown = () => {
  engine.stop();
  server.close();
  store.event('info', 'Engine stopped');
  store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (e) => store.event('error', `Unhandled: ${(e as Error)?.message ?? e}`));
