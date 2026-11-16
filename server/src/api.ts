import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync, createWriteStream, renameSync, unlinkSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { resolve, extname, normalize } from 'node:path';
import type { Engine } from './engine.ts';
import { startExperiment } from './engine.ts';
import { ROOT } from './config.ts';
import { buildReport, DISCLAIMER } from './report.ts';
import { maxDrawdown, tradeStats, utcDay } from './accounting.ts';
import { inspectDb } from './dbimport.ts';
import { readLease } from './lease.ts';
import { rulesFor, drawdownFromPeak } from './risk.ts';
import type { Experiment } from './db.ts';
import { ChartError, positionChart } from './candles.ts';

export interface ApiOptions {
  host?: string;
  /** Live database file (used by the one-time import). */
  dbFile?: string;
  /** Called after a database has been staged for import; should stop the process so it restarts and applies it. */
  restart?: () => void;
}

const MAX_IMPORT_BYTES = 512 * 1024 * 1024;

/** Mutating endpoints need `Authorization: Bearer $ADMIN_TOKEN` when ADMIN_TOKEN is set (always set it on a public deployment). */
function authorized(req: IncomingMessage): boolean {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return true;
  const got = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Stream the request body to a file, enforcing a size cap. */
function saveBody(req: IncomingMessage, file: string): Promise<number> {
  return new Promise((ok, fail) => {
    let n = 0;
    const out = createWriteStream(file);
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > MAX_IMPORT_BYTES) {
        req.destroy();
        out.destroy();
        fail(new Error('upload too large'));
      }
    });
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => ok(n));
    req.pipe(out);
  });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg',
};

/** Downsample a series to at most n points for the chart. */
function thin<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  const step = xs.length / n;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(xs[Math.floor(i * step)]);
  out.push(xs[xs.length - 1]);
  return out;
}

/** Compact list for the experiment switcher. */
export function experimentList(engine: Engine) {
  return engine.store.experiments().map((e) => ({
    id: e.id, kind: e.kind, status: e.status, startedAt: e.startedAt, endsAt: rulesFor(e, engine.cfg).endsAt, finishedAt: e.finishedAt, initialIsk: e.initialIsk,
    botStatus: engine.statusOf(e.id).status,
  }));
}

/** Resolve ?experiment=<id>; default is the oldest running experiment (else the latest). */
function pickExperiment(engine: Engine, raw: string | null): Experiment | undefined {
  if (raw == null || raw === '') return engine.store.experiment();
  const id = Number(raw);
  if (!Number.isInteger(id)) throw new Error('experiment must be an id');
  const e = engine.store.experimentById(id);
  if (!e) throw new Error(`no experiment #${id}`);
  return e;
}

export function stateSnapshot(engine: Engine, expId?: number) {
  const { store, cfg } = engine;
  const now = engine.clock();
  const exp = expId != null ? store.experimentById(expId) : store.experiment();
  const health = engine.dataHealth(now);
  const st = engine.statusOf(exp?.id);
  const rules = exp ? rulesFor(exp, cfg) : null;
  const base = {
    disclaimer: DISCLAIMER,
    now,
    experiments: experimentList(engine),
    bot: { status: st.status, detail: st.detail, lastTickAt: engine.lastTickAt, tickMs: engine.tickMs, pollSeconds: cfg.pollSeconds, lease: readLease(store) },
    data: {
      healthy: health.healthy,
      problems: health.problems,
      solUsd: engine.solUsd,
      iskPerUsd: engine.iskPerUsd,
      fxAsOf: engine.fxAsOf,
      feeds: store.health(),
    },
    config: {
      maxPositionIsk: cfg.maxPositionIsk, maxOpenPositions: cfg.maxOpenPositions, takeProfitPct: cfg.takeProfitPct, stopLossPct: cfg.stopLossPct,
      // Per-experiment halts: null = that halt does not apply to the selected experiment.
      dailyLossLimitIsk: rules ? rules.dailyLossLimitIsk : cfg.dailyLossLimitIsk,
      maxDrawdownPct: rules ? rules.maxDrawdownPct : null,
      trailingActivatePct: cfg.trailingActivatePct, trailingDistancePct: cfg.trailingDistancePct,
      maxHoldMinutes: cfg.maxHoldMinutes, minEntryScore: cfg.minEntryScore, failureProbability: cfg.failureProbability,
    },
    tokens: store.tokens().map((t) => {
      const m = t.marketJson ? JSON.parse(t.marketJson) : null;
      return {
        address: t.address, symbol: t.symbol, name: t.name, status: t.status, rejectReason: t.rejectReason, score: t.score, explanation: t.scoreExplanation,
        priceUsd: m?.priceUsd ?? null, liquidityUsd: m?.liquidityUsd ?? null, volume24h: m?.volume?.h24 ?? null, change1h: m?.change?.h1 ?? null, change5m: m?.change?.m5 ?? null,
        safety: t.safetyJson ? JSON.parse(t.safetyJson) : null,
      };
    }),
    events: exp ? store.events(40, exp.id, exp.startedAt) : store.events(40),
  };
  if (!exp) return { ...base, experiment: null };

  const solIsk = engine.solIsk;
  const open = store.openPositions(exp.id).map((p) => {
    const mark = engine.markSol(p.tokenAddress);
    const m = mark ?? p.lastMarkSol;
    const valueIsk = solIsk ? p.tokenAmount * m * solIsk : null;
    return {
      ...p, markSol: m, markFresh: mark != null, valueIsk,
      unrealizedIsk: valueIsk == null ? null : valueIsk - p.costIsk - p.extraFeesIsk,
      changePct: (m / p.entryPriceSol - 1) * 100,
      tpPriceSol: p.entryPriceSol * (1 + cfg.takeProfitPct), slPriceSol: p.entryPriceSol * (1 - cfg.stopLossPct),
    };
  });
  const posValue = open.reduce((s, p) => s + (p.valueIsk ?? 0), 0);
  const eqSeries = store.equity(exp.id);
  const live = solIsk ? exp.cashIsk + posValue : eqSeries[eqSeries.length - 1]?.equityIsk ?? exp.cashIsk;
  const dayStart = store.dayStart(exp.id, utcDay(now)) ?? live;
  const closed = store.closedPositions(exp.id);
  const totals = store.tradeTotals(exp.id);
  const lastSolHold = eqSeries[eqSeries.length - 1]?.solHoldIsk ?? exp.initialIsk;
  const peak = Math.max(exp.peakEquityIsk ?? exp.initialIsk, live);
  const solHold = solIsk && exp.status === 'running' ? exp.initialIsk * (solIsk / (exp.solUsdStart * exp.iskPerUsdStart)) : lastSolHold;

  return {
    ...base,
    experiment: {
      id: exp.id, kind: exp.kind, status: exp.status, startedAt: exp.startedAt, endsAt: rules!.endsAt, initialIsk: exp.initialIsk,
      finishedAt: exp.finishedAt, haltedAt: exp.haltedAt, haltReason: exp.haltReason,
      peakEquityIsk: peak, currentDrawdownPct: drawdownFromPeak(live, peak) * 100,
      cashIsk: exp.cashIsk, equityIsk: live, positionsIsk: posValue,
      totalPnlIsk: live - exp.initialIsk, dailyPnlIsk: live - dayStart, dailyLossUsedIsk: Math.max(0, dayStart - live),
      solHoldIsk: solHold,
      drawdown: maxDrawdown([...eqSeries, { ts: now, equityIsk: live }]),
      stats: tradeStats(closed.map((p) => ({ netPnlIsk: p.netPnlIsk ?? 0 }))),
      costs: { feesIsk: totals.feeIsk, slippageIsk: totals.slippageIsk, failed: totals.failed ?? 0, filled: totals.filled ?? 0 },
      equity: thin(eqSeries, 400),
      openPositions: open,
      closedPositions: closed.slice(0, 50),
      trades: store.trades(exp.id, 60),
      hasFinalReport: !!exp.reportJson,
    },
  };
}

export function startApi(engine: Engine, port: number, opts: ApiOptions = {}) {
  const dist = resolve(ROOT, 'web', 'dist');
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body, (_k, v) => (v === Infinity ? null : v)));
    };
    try {
      if (url.pathname === '/api/state') {
        let exp: Experiment | undefined;
        try {
          exp = pickExperiment(engine, url.searchParams.get('experiment'));
        } catch (e) {
          return json(404, { error: (e as Error).message });
        }
        return json(200, stateSnapshot(engine, exp?.id));
      }
      if (url.pathname === '/api/experiments') return json(200, { experiments: experimentList(engine) });
      if (url.pathname === '/api/health') {
        const exp = engine.store.experiment();
        return json(200, {
          ok: true, simulated: true, status: engine.status, detail: engine.statusDetail, lastTickAt: engine.lastTickAt,
          experiment: exp ? { id: exp.id, kind: exp.kind, status: exp.status, startedAt: exp.startedAt, endsAt: exp.endsAt } : null,
          experiments: experimentList(engine),
          lease: readLease(engine.store),
        });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/') && !authorized(req)) return json(401, { error: 'admin token required' });
      if (url.pathname === '/api/admin/import' && req.method === 'POST') {
        // One-time migration: only into a database that has never held an experiment. Nothing is overwritten or deleted.
        if (!process.env.ADMIN_TOKEN) return json(403, { error: 'import disabled: set ADMIN_TOKEN first' });
        if (!opts.dbFile || !opts.restart) return json(501, { error: 'import not available' });
        if (engine.store.experiment()) return json(409, { error: 'this deployment already has an experiment; refusing to overwrite it' });
        const tmp = `${opts.dbFile}.upload-${Date.now()}`;
        try {
          const bytes = await saveBody(req, tmp);
          const info = inspectDb(tmp);
          if (!info.ok) throw new Error(info.error);
          if (info.experiments === 0) throw new Error('uploaded database holds no experiment');
          renameSync(tmp, `${opts.dbFile}.import`);
          json(202, { staged: true, bytes, ...info, next: 'engine restarting to apply the import' });
          setTimeout(opts.restart, 500);
          return;
        } catch (e) {
          if (existsSync(tmp)) unlinkSync(tmp);
          return json(400, { error: (e as Error).message });
        }
      }
      if (url.pathname === '/api/report') {
        let exp: Experiment | undefined;
        try {
          exp = pickExperiment(engine, url.searchParams.get('experiment'));
        } catch (e) {
          return json(404, { error: (e as Error).message });
        }
        if (!exp) return json(404, { error: 'no experiment' });
        return json(200, exp.reportJson ? JSON.parse(exp.reportJson) : buildReport(engine.store, exp.id, engine.clock(), engine.cfg));
      }
      if (url.pathname === '/api/experiment/start' && req.method === 'POST') {
        // ?kind=continuous starts the separate continuous experiment; default is the original seven-day kind.
        const kind = url.searchParams.get('kind') ?? 'seven_day';
        if (kind !== 'seven_day' && kind !== 'continuous') return json(400, { error: 'kind must be seven_day or continuous' });
        const id = await startExperiment(engine.store, engine.cfg, engine.feeds, engine.clock(), kind);
        void engine.tick();
        return json(200, { id });
      }
      // Read-only market history for one position's chart. Never trades.
      const chartMatch = req.method === 'GET' ? /^\/api\/positions\/(\d+)\/chart$/.exec(url.pathname) : null;
      if (chartMatch) {
        try {
          return json(200, await positionChart(engine.store, engine.cfg, Number(chartMatch[1]), url.searchParams.get('tf')));
        } catch (e) {
          if (e instanceof ChartError) return json(e.status, { error: e.message, retryAfter: e.retryAfter ?? null });
          throw e;
        }
      }
      if (url.pathname.startsWith('/api/')) return json(404, { error: 'not found' });

      // Static dashboard
      let file = resolve(dist, '.' + normalize(url.pathname));
      if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = resolve(dist, 'index.html');
      if (!existsSync(file)) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        return res.end('Dashboard not built. Run `npm run build` first.');
      }
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
      });
      res.end(readFileSync(file));
    } catch (e) {
      json(400, { error: (e as Error).message });
    }
  });
  server.listen(port, opts.host ?? '127.0.0.1');
  return server;
}
