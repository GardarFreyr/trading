import type { Config } from './config.ts';

export interface RiskContext {
  now: number;
  experimentStatus: 'running' | 'finished' | 'none';
  endsAt: number;
  openPositions: number;
  cashIsk: number;
  /** Equity now minus equity at the start of the current UTC day (includes unrealized and all costs). */
  dailyPnlIsk: number;
  dataHealthy: boolean;
}

export type RiskDecision = { ok: true } | { ok: false; reason: string };

/** Minimum order so fixed network fees don't dominate a tiny position. */
export const MIN_ORDER_ISK = 100;

export function canOpenPosition(ctx: RiskContext, cfg: Config): RiskDecision {
  if (ctx.experimentStatus !== 'running') return { ok: false, reason: 'no running experiment' };
  if (ctx.now >= ctx.endsAt) return { ok: false, reason: 'experiment window has ended' };
  if (!ctx.dataHealthy) return { ok: false, reason: 'market data stale or unavailable' };
  if (dailyLossLimitHit(ctx.dailyPnlIsk, cfg))
    return { ok: false, reason: `daily loss limit reached (${ctx.dailyPnlIsk.toFixed(0)} ISK ≤ −${cfg.dailyLossLimitIsk})` };
  if (ctx.openPositions >= cfg.maxOpenPositions)
    return { ok: false, reason: `max ${cfg.maxOpenPositions} open positions` };
  if (positionSizeIsk(ctx.cashIsk, cfg) < MIN_ORDER_ISK) return { ok: false, reason: 'insufficient cash' };
  return { ok: true };
}

export function dailyLossLimitHit(dailyPnlIsk: number, cfg: Config): boolean {
  return dailyPnlIsk <= -cfg.dailyLossLimitIsk;
}

/** Size includes the network fee reserve: total ISK leaving cash never exceeds maxPositionIsk. */
export function positionSizeIsk(cashIsk: number, cfg: Config): number {
  return Math.max(0, Math.min(cfg.maxPositionIsk, cashIsk));
}
