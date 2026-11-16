import type { Config } from './config.ts';
import type { Experiment } from './db.ts';

/**
 * The risk rules that apply to one experiment. Position size, max positions, SL/TP, trailing stop and
 * time stop come from the shared config for every experiment; only the halts differ by kind.
 */
export interface ExperimentRules {
  kind: Experiment['kind'];
  /** Daily loss that halts new entries and liquidates (null = no daily halt; daily P/L is still recorded). */
  dailyLossLimitIsk: number | null;
  /** Peak-to-current equity drawdown that permanently halts the experiment (null = none). */
  maxDrawdownPct: number | null;
  /** null = no end date. */
  endsAt: number | null;
}

export function rulesFor(exp: Pick<Experiment, 'kind' | 'maxDrawdownPct' | 'endsAt'>, cfg: Config): ExperimentRules {
  if (exp.kind === 'continuous') return { kind: 'continuous', dailyLossLimitIsk: null, maxDrawdownPct: exp.maxDrawdownPct, endsAt: null };
  // seven_day: exactly the original rules.
  return { kind: 'seven_day', dailyLossLimitIsk: cfg.dailyLossLimitIsk, maxDrawdownPct: null, endsAt: exp.endsAt };
}

/** Drawdown from the equity peak, as a fraction (0.2 = 20%). */
export function drawdownFromPeak(equityIsk: number, peakIsk: number): number {
  return peakIsk > 0 ? Math.max(0, (peakIsk - equityIsk) / peakIsk) : 0;
}

export function drawdownHaltHit(equityIsk: number, peakIsk: number, rules: ExperimentRules): boolean {
  return rules.maxDrawdownPct != null && drawdownFromPeak(equityIsk, peakIsk) >= rules.maxDrawdownPct;
}

export interface RiskContext {
  now: number;
  experimentStatus: 'running' | 'finished' | 'halted' | 'none';
  endsAt: number;
  openPositions: number;
  cashIsk: number;
  /** Equity now minus equity at the start of the current UTC day (includes unrealized and all costs). */
  dailyPnlIsk: number;
  dataHealthy: boolean;
  /** Per-experiment daily loss limit; omitted = the config value (seven-day rules), null = no daily halt. */
  dailyLossLimitIsk?: number | null;
}

export type RiskDecision = { ok: true } | { ok: false; reason: string };

/** Minimum order so fixed network fees don't dominate a tiny position. */
export const MIN_ORDER_ISK = 100;

export function canOpenPosition(ctx: RiskContext, cfg: Config): RiskDecision {
  if (ctx.experimentStatus !== 'running') return { ok: false, reason: 'no running experiment' };
  if (ctx.now >= ctx.endsAt) return { ok: false, reason: 'experiment window has ended' };
  if (!ctx.dataHealthy) return { ok: false, reason: 'market data stale or unavailable' };
  const limit = ctx.dailyLossLimitIsk === undefined ? cfg.dailyLossLimitIsk : ctx.dailyLossLimitIsk;
  if (dailyLossLimitHit(ctx.dailyPnlIsk, cfg, limit))
    return { ok: false, reason: `daily loss limit reached (${ctx.dailyPnlIsk.toFixed(0)} ISK ≤ −${limit})` };
  if (ctx.openPositions >= cfg.maxOpenPositions)
    return { ok: false, reason: `max ${cfg.maxOpenPositions} open positions` };
  if (positionSizeIsk(ctx.cashIsk, cfg) < MIN_ORDER_ISK) return { ok: false, reason: 'insufficient cash' };
  return { ok: true };
}

export function dailyLossLimitHit(dailyPnlIsk: number, cfg: Config, limit: number | null = cfg.dailyLossLimitIsk): boolean {
  return limit != null && dailyPnlIsk <= -limit;
}

/** Size includes the network fee reserve: total ISK leaving cash never exceeds maxPositionIsk. */
export function positionSizeIsk(cashIsk: number, cfg: Config): number {
  return Math.max(0, Math.min(cfg.maxPositionIsk, cashIsk));
}
