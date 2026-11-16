import type { Config } from './config.ts';
import { claimLease, releaseLease } from './lease.ts';
import { SOL_MINT } from './config.ts';
import type { Store, Position, Experiment, ExperimentKind } from './db.ts';
import { NO_END } from './db.ts';
import type { Market } from './feeds/dexscreener.ts';
import type { Quote } from './feeds/jupiter.ts';
import type { TokenSafety } from './feeds/solana.ts';
import { FeedError } from './feeds/http.ts';
import { filterToken, scoreMomentum, checkExit } from './strategy.ts';
import { simulateSwap, modelQuote, networkFeeSol } from './execution.ts';
import type { SimQuote, ExecResult } from './execution.ts';
import { canOpenPosition, dailyLossLimitHit, positionSizeIsk, rulesFor, drawdownFromPeak, drawdownHaltHit } from './risk.ts';
import { buyCostIsk, sellProceedsIsk, utcDay, positionValueIsk } from './accounting.ts';
import { finalizeExperiment } from './report.ts';

/** Everything the engine needs from the outside world — injectable for tests. */
export interface Feeds {
  discover(): Promise<string[]>;
  markets(addresses: string[]): Promise<Map<string, Market>>;
  quote(inputMint: string, outputMint: string, raw: bigint, outDecimals: number): Promise<Quote>;
  safety(mint: string, pairAddress: string): Promise<TokenSafety>;
  iskPerUsd(): Promise<{ rate: number; asOf: number }>;
}

export type BotStatus = 'STARTING' | 'RUNNING' | 'PAUSED_STALE_DATA' | 'HALTED_DAILY_LOSS' | 'HALTED_DRAWDOWN' | 'IDLE_NO_EXPERIMENT' | 'FINISHED' | 'STANDBY';

export function toRaw(amount: number, decimals: number): bigint {
  const [i, f = ''] = amount.toFixed(Math.min(decimals, 20)).split('.');
  return BigInt(i + f.padEnd(decimals, '0').slice(0, decimals));
}

const SAFETY_TTL = 60 * 60_000;
const SAFETY_RETRY = 10 * 60_000;

export class Engine {
  cfg: Config;
  store: Store;
  feeds: Feeds;
  clock: () => number;
  rng: () => number;

  /** Engine-wide status; mirrors the default experiment (see Store.experiment) unless the engine itself is idle or on standby. */
  status: BotStatus = 'STARTING';
  statusDetail = '';
  /** Each running experiment's own status. Experiments never share status, cash, positions or cooldowns. */
  expStatus = new Map<number, { status: BotStatus; detail: string }>();
  markets = new Map<string, Market>();
  solUsd: number | null = null;
  solUsdAt = 0;
  iskPerUsd: number | null = null;
  fxAsOf = 0;
  fxFetchedAt = 0;
  lastMarketsOk = 0;
  lastDiscovery = 0;
  private lastEquityAt = new Map<number, number>();
  lastTickAt = 0;
  tickMs = 0;
  private pending = new Set<string>();
  private busy = false;
  private timer: NodeJS.Timeout | null = null;
  /** When set, this engine only trades while it holds the database lease (see lease.ts). */
  private lease: { owner: string; label: string } | null = null;

  constructor(cfg: Config, store: Store, feeds: Feeds, clock: () => number = Date.now, rng: () => number = Math.random) {
    this.cfg = cfg;
    this.store = store;
    this.feeds = feeds;
    this.clock = clock;
    this.rng = rng;
    const fx = store.kvGet('fx');
    if (fx) Object.assign(this, JSON.parse(fx));
  }

  start() {
    this.store.event('info', 'Engine started (paper trading only — no wallet, no real orders)');
    const loop = async () => {
      await this.tick();
      this.timer = setTimeout(loop, this.cfg.pollSeconds * 1000);
    };
    void loop();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.lease) releaseLease(this.store, this.lease.owner);
  }

  /** Require the single-engine lease before every tick. */
  useLease(owner: string, label: string) {
    this.lease = { owner, label };
  }

  /** Renew (or try to take) the lease. False means another live engine owns this database. */
  private holdLease(now: number): boolean {
    if (!this.lease) return true;
    const r = claimLease(this.store, this.lease.owner, this.lease.label, now);
    if (!r.held) {
      const age = Math.round((now - r.holder.heartbeat) / 1000);
      this.expStatus.clear();
      this.setStatus('STANDBY', `Another engine (${r.holder.label}, ${r.holder.owner}) holds the trading lease (heartbeat ${age}s ago). This one will not trade.`);
    }
    return r.held;
  }

  get solIsk(): number | null {
    return this.solUsd && this.iskPerUsd ? this.solUsd * this.iskPerUsd : null;
  }

  dataHealth(now = this.clock()) {
    const stale = this.cfg.priceStaleSeconds * 1000;
    const problems: string[] = [];
    if (now - this.lastMarketsOk > stale) problems.push('DexScreener prices stale');
    if (!this.solUsd || now - this.solUsdAt > stale) problems.push('SOL price stale');
    if (!this.iskPerUsd || now - this.fxAsOf > this.cfg.fxStaleHours * 3_600_000) problems.push('USD/ISK rate stale');
    return { healthy: problems.length === 0, problems };
  }

  private async timed<T>(feed: string, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    try {
      const r = await fn();
      this.store.healthOk(feed, Date.now() - t0, this.clock());
      return r;
    } catch (e) {
      this.store.healthErr(feed, (e as Error).message, this.clock());
      throw e;
    }
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const t0 = Date.now();
    try {
      if (!this.holdLease(this.clock())) return;
      await this.refreshData();
      await this.trade();
    } catch (e) {
      this.store.event('error', `Tick failed: ${(e as Error).message}`, this.clock());
    } finally {
      this.lastTickAt = this.clock();
      this.tickMs = Date.now() - t0;
      this.busy = false;
    }
  }

  // ---------- Market data ----------

  private async refreshData() {
    const now = this.clock();
    if (now - this.fxFetchedAt > 3_600_000) {
      try {
        const fx = await this.timed('fx', () => this.feeds.iskPerUsd());
        this.iskPerUsd = fx.rate;
        this.fxAsOf = fx.asOf;
        this.fxFetchedAt = now;
        this.store.kvSet('fx', JSON.stringify({ iskPerUsd: fx.rate, fxAsOf: fx.asOf, fxFetchedAt: now }));
      } catch {
        this.fxFetchedAt = now - 3_300_000; // retry in ~5 min
      }
    }

    if (now - this.lastDiscovery > this.cfg.discoverySeconds * 1000) {
      this.lastDiscovery = now;
      try {
        const found = await this.timed('dexscreener-discovery', () => this.feeds.discover());
        for (const a of found) {
          if (this.store.token(a)) this.store.updateToken(a, { lastSeen: now });
          else this.pending.add(a);
        }
      } catch {
        /* recorded in health */
      }
    }

    // Keep pricing every token any running experiment holds.
    const open = this.store.runningExperiments().flatMap((e) => this.store.openPositions(e.id).map((p) => p.tokenAddress));
    const watched = this.store.tokens().filter((t) => t.status !== 'unsafe').map((t) => t.address);
    const addrs = [...new Set([SOL_MINT, ...open, ...this.pending, ...watched])].slice(0, this.cfg.maxWatchlist + 30);

    let mk: Map<string, Market>;
    try {
      mk = await this.timed('dexscreener-prices', () => this.feeds.markets(addrs));
    } catch {
      return;
    }
    const sol = mk.get(SOL_MINT);
    if (!sol) {
      this.store.healthErr('dexscreener-prices', 'SOL pair missing from response', now);
      return;
    }
    this.lastMarketsOk = now;
    this.solUsd = sol.priceUsd;
    this.solUsdAt = now;
    mk.delete(SOL_MINT);
    this.markets = mk;

    for (const [addr, m] of mk) {
      if (this.pending.has(addr)) {
        this.store.upsertToken({ address: addr, symbol: m.symbol, name: m.name, pairAddress: m.pairAddress }, now);
        this.pending.delete(addr);
      }
      if (this.store.token(addr)) {
        this.store.updateToken(addr, { marketJson: JSON.stringify(m), pairAddress: m.pairAddress });
        this.store.addSnapshot(addr, now, m.priceUsd);
      }
    }
    this.pending.clear(); // addresses DexScreener had no Solana pair for are dropped
    this.pruneWatchlist(now, new Set(open));
  }

  private pruneWatchlist(now: number, keep: Set<string>) {
    // Keep tradeable candidates first, then the most recently discovered rejects.
    const all = this.store.tokens().sort((a, b) => Number(a.status !== 'watching') - Number(b.status !== 'watching') || b.lastSeen - a.lastSeen);
    let n = 0;
    for (const t of all) {
      n++;
      if (keep.has(t.address)) continue;
      const tooMany = n > this.cfg.maxWatchlist;
      const gone = now - t.lastSeen > 12 * 3_600_000 && !this.markets.has(t.address);
      if (tooMany || gone) this.store.deleteToken(t.address);
    }
    if (Math.floor(now / 600_000) !== Math.floor((now - this.cfg.pollSeconds * 1000) / 600_000))
      this.store.pruneSnapshots(now - 24 * 3_600_000);
  }

  // ---------- Trading ----------

  markSol(addr: string): number | null {
    const m = this.markets.get(addr);
    if (!m || !this.solUsd) return null;
    return m.priceUsd / this.solUsd;
  }

  equityIsk(exp: Experiment): { equity: number; positions: number } | null {
    const solIsk = this.solIsk;
    if (!solIsk) return null;
    let positions = 0;
    for (const p of this.store.openPositions(exp.id)) positions += positionValueIsk(p.tokenAmount, this.markSol(p.tokenAddress) ?? p.lastMarkSol, solIsk);
    return { equity: exp.cashIsk + positions, positions };
  }

  private async trade() {
    const now = this.clock();
    const health = this.dataHealth(now);

    // Score every watched token (also when idle, so the dashboard shows the pipeline).
    this.scoreTokens(now);

    const running = this.store.runningExperiments();
    for (const id of [...this.expStatus.keys()]) if (!running.some((e) => e.id === id)) this.expStatus.delete(id);
    if (!running.length) {
      const last = this.store.experiment();
      if (!last) return this.setStatus('IDLE_NO_EXPERIMENT', 'Run `npm run experiment:start` or use the dashboard to begin.');
      if (last.status === 'halted') return this.setStatus('HALTED_DRAWDOWN', last.haltReason ?? 'Stopped by the drawdown safety halt.');
      return this.setStatus('FINISHED', 'Seven-day experiment complete — see final report.');
    }
    // Each experiment trades on its own books. A failure in one never stops the other.
    for (const exp of running) {
      try {
        await this.tradeExperiment(exp, now, health);
      } catch (e) {
        this.store.event('error', `#${exp.id} tick failed: ${(e as Error).message}`, this.clock(), exp.id);
      }
    }
    const primary = this.store.experiment();
    const ps = primary && this.expStatus.get(primary.id);
    if (ps) this.setStatus(ps.status, ps.detail, false);
  }

  private async tradeExperiment(start: Experiment, now: number, health: { healthy: boolean; problems: string[] }) {
    const id = start.id;
    const rules = rulesFor(start, this.cfg);

    if (!health.healthy) return this.setExpStatus(id, 'PAUSED_STALE_DATA', health.problems.join('; '));

    const solIsk = this.solIsk!;
    const eq = this.equityIsk(start)!;
    const day = utcDay(now);
    this.store.setDayStart(id, day, eq.equity);
    const dailyPnl = eq.equity - (this.store.dayStart(id, day) ?? eq.equity);
    const ended = rules.endsAt != null && now >= rules.endsAt;
    const lossHalt = dailyLossLimitHit(dailyPnl, this.cfg, rules.dailyLossLimitIsk);

    // Total-portfolio drawdown safety halt (only for experiments that carry one; the seven-day rules have none).
    let ddHalt = start.haltedAt != null;
    if (rules.maxDrawdownPct != null) {
      const peak = Math.max(start.peakEquityIsk ?? start.initialIsk, eq.equity);
      if (peak !== start.peakEquityIsk) this.store.updateExperiment(id, { peakEquityIsk: peak });
      if (!ddHalt && drawdownHaltHit(eq.equity, peak, rules)) {
        const reason = `Drawdown halt: equity ${eq.equity.toFixed(0)} ISK is ${(drawdownFromPeak(eq.equity, peak) * 100).toFixed(1)}% below its peak of ${peak.toFixed(0)} ISK (limit ${(rules.maxDrawdownPct * 100).toFixed(0)}%)`;
        this.store.updateExperiment(id, { haltedAt: now, haltReason: reason });
        this.store.event('warn', `#${id} ${reason}. Liquidating all positions; this experiment will not trade again.`, now, id);
        ddHalt = true;
      }
    }

    // Exits first.
    for (const p of this.store.openPositions(id)) {
      const mark = this.markSol(p.tokenAddress);
      if (mark == null) continue; // no fresh price for this token: hold, never guess
      const peak = Math.max(p.peakPriceSol, mark);
      this.store.updatePosition(p.id, { peakPriceSol: peak, lastMarkSol: mark });
      const rule = checkExit({ entryPriceSol: p.entryPriceSol, peakPriceSol: peak, openedAt: p.openedAt }, mark, now, this.cfg);
      let exit: { kind: string; reason: string } | null = rule;
      if (ended) exit = { kind: 'EXPERIMENT_END', reason: 'Experiment ended: liquidating' };
      else if (!exit && ddHalt) exit = { kind: 'DRAWDOWN_HALT', reason: `Drawdown safety halt (≥ ${((rules.maxDrawdownPct ?? 0) * 100).toFixed(0)}% below peak equity)` };
      else if (!exit && lossHalt) exit = { kind: 'DAILY_LOSS_LIMIT', reason: `Daily loss limit: day P/L ${dailyPnl.toFixed(0)} ISK ≤ −${rules.dailyLossLimitIsk}` };
      if (exit) await this.sell({ ...p, peakPriceSol: peak }, mark, solIsk, exit.kind, exit.reason);
    }

    let exp = this.store.experimentById(id)!;
    if (ended) {
      if (this.store.openPositions(id).length === 0) {
        this.recordEquity(exp, now, true);
        finalizeExperiment(this.store, id, this.clock(), this.cfg);
        this.store.event('info', 'Seven-day experiment finished. Final report written to reports/.', now, id);
        return this.setExpStatus(id, 'FINISHED', 'Seven-day experiment complete — see final report.');
      }
      this.setExpStatus(id, 'RUNNING', 'Experiment ended — liquidating remaining positions');
      return this.recordEquity(exp, now);
    }
    if (exp.haltedAt != null) {
      if (this.store.openPositions(id).length === 0) {
        this.recordEquity(exp, now, true);
        finalizeExperiment(this.store, id, this.clock(), this.cfg, 'halted');
        this.store.event('warn', `#${id} stopped by the drawdown safety halt. All positions closed; final report saved.`, now, id);
        return this.setExpStatus(id, 'HALTED_DRAWDOWN', exp.haltReason ?? 'Drawdown safety halt');
      }
      this.setExpStatus(id, 'HALTED_DRAWDOWN', 'Drawdown safety halt — liquidating remaining positions');
      return this.recordEquity(exp, now);
    }

    const eq2 = this.equityIsk(exp)!;
    const daily2 = eq2.equity - (this.store.dayStart(id, day) ?? eq2.equity);
    const decision = canOpenPosition(
      {
        now,
        experimentStatus: exp.status,
        endsAt: rules.endsAt ?? Infinity,
        openPositions: this.store.openPositions(id).length,
        cashIsk: exp.cashIsk,
        dailyPnlIsk: daily2,
        dataHealthy: true,
        dailyLossLimitIsk: rules.dailyLossLimitIsk,
      },
      this.cfg,
    );
    if (dailyLossLimitHit(daily2, this.cfg, rules.dailyLossLimitIsk)) this.setExpStatus(id, 'HALTED_DAILY_LOSS', `No new entries until 00:00 UTC (day P/L ${daily2.toFixed(0)} ISK)`);
    else this.setExpStatus(id, 'RUNNING', decision.ok ? 'Scanning for entries' : `Not entering: ${decision.reason}`);

    if (decision.ok) await this.tryEntry(exp, now, solIsk);
    this.recordEquity(this.store.experimentById(id)!, now);
  }

  /** Status of one experiment (engine-wide standby/idle wins, since then nothing trades). */
  statusOf(expId: number | null | undefined): { status: BotStatus; detail: string } {
    if (expId == null || this.status === 'STANDBY' || this.status === 'STARTING') return { status: this.status, detail: this.statusDetail };
    const s = this.expStatus.get(expId);
    if (s) return s;
    const e = this.store.experimentById(expId);
    if (e?.status === 'halted') return { status: 'HALTED_DRAWDOWN', detail: e.haltReason ?? 'Stopped by the drawdown safety halt.' };
    if (e?.status === 'finished') return { status: 'FINISHED', detail: 'Experiment complete — see final report.' };
    return { status: this.status, detail: this.statusDetail };
  }

  private setStatus(s: BotStatus, detail: string, log = true) {
    if (log && s !== this.status) this.store.event(s === 'RUNNING' ? 'info' : 'warn', `Status → ${s}: ${detail}`, this.clock());
    this.status = s;
    this.statusDetail = detail;
  }

  private setExpStatus(id: number, s: BotStatus, detail: string) {
    const prev = this.expStatus.get(id);
    if (prev?.status !== s) this.store.event(s === 'RUNNING' ? 'info' : 'warn', `#${id} status → ${s}: ${detail}`, this.clock(), id);
    this.expStatus.set(id, { status: s, detail });
  }

  private recordEquity(exp: Experiment, now: number, force = false) {
    if (!force && now - (this.lastEquityAt.get(exp.id) ?? 0) < this.cfg.equitySnapshotSeconds * 1000) return;
    if (!force && now - this.lastMarketsOk > this.cfg.pollSeconds * 1000) return; // only chart prices from the latest successful fetch
    const eq = this.equityIsk(exp);
    if (!eq || !this.solUsd || !this.iskPerUsd) return;
    this.lastEquityAt.set(exp.id, now);
    const solHold = exp.initialIsk * ((this.solUsd * this.iskPerUsd) / (exp.solUsdStart * exp.iskPerUsdStart));
    this.store.addEquity({ experimentId: exp.id, ts: now, equityIsk: eq.equity, cashIsk: exp.cashIsk, positionsIsk: eq.positions, solHoldIsk: solHold });
  }

  private scoreTokens(now: number) {
    for (const t of this.store.tokens()) {
      if (t.status === 'unsafe') continue;
      const m = this.markets.get(t.address);
      if (!m) continue;
      const f = filterToken(m, this.cfg, now);
      if (!f.ok) {
        this.store.updateToken(t.address, { status: 'rejected', rejectReason: f.reasons.join('; '), score: null, scoreExplanation: null });
        continue;
      }
      const s = scoreMomentum(m, this.store.history(t.address, now - 60 * 60_000), now, this.cfg);
      const rr = t.rejectReason?.startsWith('pre-trade:') && t.lastExitAt && now - t.lastExitAt < this.cfg.reentryCooldownMinutes * 60_000;
      this.store.updateToken(t.address, {
        status: rr ? 'rejected' : 'watching',
        rejectReason: rr ? t.rejectReason : null,
        score: s.score,
        scoreExplanation: (s.ready ? '' : '[waiting] ') + s.explanation,
      });
    }
  }

  private async ensureSafety(addr: string, pairAddress: string, now: number): Promise<TokenSafety | null> {
    const t = this.store.token(addr)!;
    if (t.safetyCheckedAt && t.safetyJson && now - t.safetyCheckedAt < SAFETY_TTL) return JSON.parse(t.safetyJson);
    if (t.safetyCheckedAt && !t.safetyJson && now - t.safetyCheckedAt < SAFETY_RETRY) return null;
    try {
      const s = await this.timed('solana-rpc', () => this.feeds.safety(addr, pairAddress));
      this.store.updateToken(addr, { safetyJson: JSON.stringify(s), safetyCheckedAt: now });
      return s;
    } catch (e) {
      this.store.updateToken(addr, { safetyJson: null, safetyCheckedAt: now });
      this.store.event('warn', `${t.symbol}: on-chain safety check unavailable (${(e as Error).message})`, now);
      return null;
    }
  }

  private reject(addr: string, reason: string, now: number, sticky = false) {
    this.store.updateToken(addr, { status: sticky ? 'unsafe' : 'rejected', rejectReason: `pre-trade: ${reason}`, lastExitAt: now });
    this.store.event('info', `${this.store.token(addr)?.symbol ?? addr}: skipped — ${reason}`, now);
  }

  private async tryEntry(exp: Experiment, now: number, solIsk: number) {
    const held = new Set(this.store.openPositions(exp.id).map((p) => p.tokenAddress));
    const cooldown = this.cfg.reentryCooldownMinutes * 60_000;
    const candidates = this.store
      .tokens()
      .filter(
        (t) =>
          t.status === 'watching' &&
          (t.score ?? 0) >= this.cfg.minEntryScore &&
          !t.scoreExplanation?.startsWith('[waiting]') &&
          !held.has(t.address) &&
          !((x) => x != null && now - x < cooldown)(this.store.lastExitAt(exp.id, t.address)) &&
          this.markets.has(t.address),
      )
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const t = candidates[0];
    if (!t) return;
    const m = this.markets.get(t.address)!;

    const safety = await this.ensureSafety(t.address, m.pairAddress, now);
    if (!safety) {
      if (this.cfg.requireSafetyData) return; // try again later, never trade blind
    } else {
      if (safety.freezeAuthority) return this.reject(t.address, 'freeze authority enabled', now, true);
      if (safety.mintAuthority) return this.reject(t.address, 'mint authority enabled', now, true);
      if (safety.top10Pct > this.cfg.maxTop10HolderPct)
        return this.reject(t.address, `top-10 holders own ${safety.top10Pct.toFixed(0)}% (excl. known pools)`, now);
    }
    const decimals = safety?.decimals;
    if (decimals == null) return;

    const sizeIsk = positionSizeIsk(exp.cashIsk, this.cfg);
    const feeSol = networkFeeSol(this.cfg);
    const solIn = sizeIsk / solIsk - feeSol;
    const mark = m.priceUsd / this.solUsd!;

    // Real Jupiter quote + round-trip check (catches sell taxes, honeypots, thin routes).
    let buyQ: Quote;
    try {
      buyQ = await this.timed('jupiter', () => this.feeds.quote(SOL_MINT, t.address, toRaw(solIn, 9), decimals));
    } catch (e) {
      if (e instanceof FeedError && e.status === 400) return this.reject(t.address, `Jupiter cannot route: ${e.message.slice(0, 80)}`, now);
      this.store.event('warn', `#${exp.id} ${t.symbol}: entry skipped, Jupiter quote unavailable (${(e as Error).message})`, now, exp.id);
      return;
    }
    let sellBack: Quote;
    try {
      sellBack = await this.timed('jupiter', () => this.feeds.quote(t.address, SOL_MINT, toRaw(buyQ.outAmount, decimals), 9));
    } catch (e) {
      if (e instanceof FeedError && e.status === 400) return this.reject(t.address, 'no sell route (possible honeypot)', now, true);
      return;
    }
    const rtLoss = (1 - sellBack.outAmount / solIn) * 100;
    if (rtLoss > this.cfg.maxRoundTripLossPct) return this.reject(t.address, `round-trip quote loses ${rtLoss.toFixed(1)}%`, now);

    const quote: SimQuote = { ...buyQ, source: 'jupiter' };
    const res = simulateSwap({ side: 'BUY', amountIn: solIn, markPriceSol: mark, quote, rng: this.rng }, this.cfg);
    const reason = `Momentum score ${t.score}: ${t.scoreExplanation}. Safety: mint/freeze authority revoked, top-10 ${safety!.top10Pct.toFixed(0)}%. Round-trip quote loss ${rtLoss.toFixed(1)}%.`;
    this.recordBuy(exp, t.address, m, decimals, solIn, mark, solIsk, quote, res, reason, now);
  }

  recordBuy(exp: Experiment, addr: string, m: Market, decimals: number, solIn: number, mark: number, solIsk: number, quote: SimQuote, res: ExecResult, reason: string, now: number) {
    const feeIsk = res.feeSol * solIsk;
    const filled = res.status === 'FILLED';
    const slippageIsk = filled ? (solIn - res.amountOut * mark) * solIsk : 0;
    const assumptions = {
      quote: `${quote.source} ${quote.route}`,
      priceImpactPct: quote.priceImpactPct,
      latencySlippageBps: res.latencySlippageBps,
      networkFee: `${this.cfg.baseFeeLamports} base + ${this.cfg.priorityFeeLamports} priority lamports`,
      failureProbability: this.cfg.failureProbability,
      slippageToleranceBps: this.cfg.slippageToleranceBps,
      fx: { solUsd: this.solUsd, iskPerUsd: this.iskPerUsd },
    };
    this.store.tx(() => {
      let positionId: number | null = null;
      const cost = filled ? buyCostIsk(solIn, res.feeSol, solIsk) : feeIsk;
      if (filled) {
        positionId = this.store.insertPosition({
          experimentId: exp.id, tokenAddress: addr, symbol: m.symbol, pairAddress: m.pairAddress, decimals,
          status: 'open', openedAt: now, closedAt: null, tokenAmount: res.amountOut, solIn, costIsk: cost,
          entryPriceSol: res.fillPriceSol!, entryMarkSol: mark, peakPriceSol: res.fillPriceSol!, lastMarkSol: mark,
          entryReason: reason, exitReason: null, exitKind: null, proceedsIsk: null, extraFeesIsk: 0, netPnlIsk: null, exitAttempts: 0,
        });
      }
      this.store.insertTrade({
        experimentId: exp.id, positionId, ts: now, side: 'BUY', status: res.status, tokenAddress: addr, symbol: m.symbol,
        quoteSource: quote.source, route: quote.route, markPriceSol: mark, quotedPriceSol: res.quotedPriceSol, fillPriceSol: res.fillPriceSol,
        solAmount: solIn, tokenAmount: res.amountOut, iskAmount: cost, solIsk, feeSol: res.feeSol, feeIsk,
        priceImpactPct: quote.priceImpactPct, latencySlippageBps: res.latencySlippageBps, slippageVsMarkBps: res.slippageVsMarkBps,
        slippageIsk, reason, failReason: res.failReason, assumptions: JSON.stringify(assumptions),
      });
      // Re-read inside the transaction: cash belongs to this experiment only.
      const cash = this.store.experimentById(exp.id)!.cashIsk;
      this.store.updateExperiment(exp.id, { cashIsk: cash - cost });
    });
    this.store.event(
      'trade',
      filled
        ? `#${exp.id} BUY ${m.symbol}: ${(solIn * solIsk).toFixed(0)} ISK at ${res.slippageVsMarkBps!.toFixed(0)} bps over mark`
        : `#${exp.id} BUY ${m.symbol} FAILED: ${res.failReason} (fee ${feeIsk.toFixed(1)} ISK lost)`,
      now,
      exp.id,
    );
  }

  private async sell(p: Position, mark: number, solIsk: number, kind: string, reason: string) {
    const now = this.clock();
    const exp = this.store.experimentById(p.experimentId)!;
    const m = this.markets.get(p.tokenAddress);
    let quote: SimQuote;
    try {
      quote = await this.timed('jupiter', () => this.feeds.quote(p.tokenAddress, SOL_MINT, toRaw(p.tokenAmount, p.decimals), 9));
    } catch (e) {
      if (!this.cfg.allowModelledFills || !m) {
        this.store.event('warn', `#${exp.id} ${p.symbol}: exit delayed, no quote (${(e as Error).message})`, now, exp.id);
        return;
      }
      quote = modelQuote('SELL', p.tokenAmount, mark, m.liquidityUsd, this.solUsd!, this.cfg);
    }
    const res = simulateSwap({ side: 'SELL', amountIn: p.tokenAmount, markPriceSol: mark, quote, rng: this.rng }, this.cfg);
    this.recordSell(exp, p, mark, solIsk, quote, res, kind, reason, now);
  }

  recordSell(exp: Experiment, p: Position, mark: number, solIsk: number, quote: SimQuote, res: ExecResult, kind: string, reason: string, now: number) {
    const feeIsk = res.feeSol * solIsk;
    const filled = res.status === 'FILLED';
    const proceeds = filled ? sellProceedsIsk(res.amountOut, res.feeSol, solIsk) : -feeIsk;
    const slippageIsk = filled ? (p.tokenAmount * mark - res.amountOut) * solIsk : 0;
    const assumptions = {
      quote: `${quote.source} ${quote.route}`,
      priceImpactPct: quote.priceImpactPct,
      latencySlippageBps: res.latencySlippageBps,
      fx: { solUsd: this.solUsd, iskPerUsd: this.iskPerUsd },
    };
    this.store.tx(() => {
      this.store.insertTrade({
        experimentId: exp.id, positionId: p.id, ts: now, side: 'SELL', status: res.status, tokenAddress: p.tokenAddress, symbol: p.symbol,
        quoteSource: quote.source, route: quote.route, markPriceSol: mark, quotedPriceSol: res.quotedPriceSol, fillPriceSol: res.fillPriceSol,
        solAmount: res.amountOut, tokenAmount: p.tokenAmount, iskAmount: proceeds, solIsk, feeSol: res.feeSol, feeIsk,
        priceImpactPct: quote.priceImpactPct, latencySlippageBps: res.latencySlippageBps, slippageVsMarkBps: res.slippageVsMarkBps,
        slippageIsk, reason, failReason: res.failReason, assumptions: JSON.stringify(assumptions),
      });
      if (filled) {
        const net = proceeds - p.costIsk - p.extraFeesIsk;
        // The re-entry cooldown is read from this experiment's own closed positions (Store.lastExitAt), so nothing shared is written here.
        this.store.updatePosition(p.id, { status: 'closed', closedAt: now, exitReason: reason, exitKind: kind, proceedsIsk: proceeds, netPnlIsk: net, exitAttempts: p.exitAttempts + 1, lastMarkSol: mark });
      } else {
        this.store.updatePosition(p.id, { extraFeesIsk: p.extraFeesIsk + feeIsk, exitAttempts: p.exitAttempts + 1 });
      }
      const cash = this.store.experimentById(exp.id)!.cashIsk;
      this.store.updateExperiment(exp.id, { cashIsk: cash + proceeds });
    });
    this.store.event(
      'trade',
      filled
        ? `#${exp.id} SELL ${p.symbol}: ${reason}. Net ${(proceeds - p.costIsk - p.extraFeesIsk).toFixed(0)} ISK after all costs`
        : `#${exp.id} SELL ${p.symbol} FAILED: ${res.failReason} — will retry`,
      now,
      exp.id,
    );
  }
}

/**
 * Create a new experiment using LIVE SOL price and FX (refuses if unavailable).
 * - 'seven_day': the original fixed seven-day window with the 350 ISK daily loss halt.
 * - 'continuous': no end date, no daily loss halt (daily P/L still recorded), 20% total-drawdown safety halt.
 * At most one running experiment of each kind. Each has its own cash, positions, equity and day starts.
 */
export async function startExperiment(store: Store, cfg: Config, feeds: Feeds, now = Date.now(), kind: ExperimentKind = 'seven_day'): Promise<number> {
  if (kind !== 'seven_day' && kind !== 'continuous') throw new Error(`unknown experiment kind: ${kind}`);
  const cur = store.runningExperiments().find((e) => e.kind === kind);
  if (cur)
    throw new Error(
      kind === 'seven_day'
        ? `Experiment #${cur.id} is already running (ends ${new Date(cur.endsAt).toISOString()})`
        : `Continuous experiment #${cur.id} is already running`,
    );
  const sol = (await feeds.markets([SOL_MINT])).get(SOL_MINT);
  if (!sol) throw new Error('Cannot start: live SOL price unavailable');
  const fx = await feeds.iskPerUsd();
  const continuous = kind === 'continuous';
  const id = store.tx(() => {
    const id = store.createExperiment({
      startedAt: now,
      endsAt: continuous ? NO_END : now + cfg.experimentDays * 86_400_000,
      initialIsk: cfg.initialCapitalIsk,
      cashIsk: cfg.initialCapitalIsk,
      status: 'running',
      solUsdStart: sol.priceUsd,
      iskPerUsdStart: fx.rate,
      kind,
      maxDrawdownPct: continuous ? cfg.continuousMaxDrawdownPct : null,
    });
    if (continuous) store.updateExperiment(id, { peakEquityIsk: cfg.initialCapitalIsk });
    store.setDayStart(id, utcDay(now), cfg.initialCapitalIsk);
    store.addEquity({ experimentId: id, ts: now, equityIsk: cfg.initialCapitalIsk, cashIsk: cfg.initialCapitalIsk, positionsIsk: 0, solHoldIsk: cfg.initialCapitalIsk });
    return id;
  });
  const what = continuous
    ? `Continuous experiment #${id} started with ${cfg.initialCapitalIsk} ISK: no daily loss halt, ${(cfg.continuousMaxDrawdownPct * 100).toFixed(0)}% drawdown safety halt`
    : `Experiment #${id} started with ${cfg.initialCapitalIsk} ISK`;
  store.event('info', `${what} (SOL $${sol.priceUsd}, 1 USD = ${fx.rate} ISK)`, now, id);
  return id;
}
