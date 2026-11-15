import type { Config } from './config.ts';
import type { Market } from './feeds/dexscreener.ts';

const fmtUsd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
/** Linear ramp: 0 at a, 1 at b. */
const ramp = (x: number, a: number, b: number) => clamp01((x - a) / (b - a));

export interface FilterResult {
  ok: boolean;
  reasons: string[];
}

/** Hard filters for suspicious / illiquid tokens. All market numbers come from DexScreener. */
export function filterToken(m: Market, cfg: Config, now: number): FilterResult {
  const r: string[] = [];
  if (m.liquidityUsd < cfg.minLiquidityUsd) r.push(`illiquid: ${fmtUsd(m.liquidityUsd)} liquidity`);
  if (m.volume.h24 < cfg.minVolume24hUsd) r.push(`low volume: ${fmtUsd(m.volume.h24)}/24h`);
  if (m.pairCreatedAt == null) r.push('pair age unknown');
  else {
    const ageH = (now - m.pairCreatedAt) / 3_600_000;
    if (ageH < cfg.minPairAgeHours) r.push(`too new: ${ageH.toFixed(1)}h old`);
    if (ageH > cfg.maxPairAgeDays * 24) r.push(`not a fresh memecoin: ${(ageH / 24).toFixed(0)}d old`);
  }
  const txH1 = m.txns.h1.buys + m.txns.h1.sells;
  if (txH1 < cfg.minTxnsH1) r.push(`thin trading: ${txH1} txns/1h`);
  if (m.change.h1 > cfg.maxPriceChangeH1Pct) r.push(`parabolic: +${m.change.h1.toFixed(0)}% in 1h`);
  if (m.fdvUsd > 0 && m.liquidityUsd / m.fdvUsd < cfg.minLiquidityToFdv)
    r.push(`liquidity only ${((m.liquidityUsd / m.fdvUsd) * 100).toFixed(1)}% of FDV`);
  if (m.txns.h1.buys > 50 && m.txns.h1.sells < m.txns.h1.buys * 0.05)
    r.push('almost no sells (possible honeypot)');
  if (m.change.h24 < -60) r.push(`collapsing: ${m.change.h24.toFixed(0)}% in 24h`);
  return { ok: r.length === 0, reasons: r };
}

export interface PricePoint {
  ts: number;
  priceUsd: number;
}

export interface Score {
  score: number;
  ready: boolean;
  explanation: string;
}

/**
 * Momentum score 0–100. DexScreener windows give the backdrop; our OWN forward observations
 * (collected while the bot runs) must confirm the move before an entry is allowed.
 */
export function scoreMomentum(m: Market, history: PricePoint[], now: number, cfg: Config): Score {
  const parts: string[] = [];
  let s = 0;

  const m5 = m.change.m5 > 15 ? 0 : ramp(m.change.m5, 0.5, 6); // fresh move, not a spike
  s += 20 * m5;
  parts.push(`5m ${m.change.m5 >= 0 ? '+' : ''}${m.change.m5.toFixed(1)}%`);

  const h1 = m.change.h1 > 80 ? 0.3 : ramp(m.change.h1, 2, 25);
  s += 20 * h1;
  parts.push(`1h ${m.change.h1 >= 0 ? '+' : ''}${m.change.h1.toFixed(1)}%`);

  const bsH1 = m.txns.h1.buys / Math.max(1, m.txns.h1.sells);
  s += 15 * ramp(bsH1, 1.0, 1.6);
  const bsM5 = m.txns.m5.buys / Math.max(1, m.txns.m5.sells);
  s += 15 * ramp(bsM5, 1.0, 1.8);
  parts.push(`buy/sell 1h ${bsH1.toFixed(2)}, 5m ${bsM5.toFixed(2)}`);

  const accel = m.volume.h1 > 0 ? (m.volume.m5 * 12) / m.volume.h1 : 0;
  s += 15 * ramp(accel, 0.9, 1.8);
  parts.push(`vol accel ${accel.toFixed(2)}x`);

  // Forward confirmation from our own samples.
  const obs = history.filter((p) => p.ts <= now).sort((a, b) => a.ts - b.ts);
  const spanMin = obs.length > 1 ? (obs[obs.length - 1].ts - obs[0].ts) / 60_000 : 0;
  let ready = spanMin >= cfg.minObservationMinutes;
  if (ready) {
    const last = obs[obs.length - 1].priceUsd;
    const ref = obs.find((p) => p.ts >= now - 5 * 60_000) ?? obs[0];
    const peak = Math.max(...obs.filter((p) => p.ts >= now - 30 * 60_000).map((p) => p.priceUsd));
    const fwd = (last / ref.priceUsd - 1) * 100;
    const offPeak = (1 - last / peak) * 100;
    parts.push(`observed ${fwd >= 0 ? '+' : ''}${fwd.toFixed(1)}% over ${Math.round((now - ref.ts) / 60_000)}m, ${offPeak.toFixed(1)}% off 30m high`);
    if (fwd > 0.3 && offPeak < 3) s += 15;
    else if (fwd < -1 || offPeak > 6) ready = false; // our own data contradicts the momentum
  } else {
    parts.push(`observing (${spanMin.toFixed(1)}/${cfg.minObservationMinutes} min)`);
  }

  parts.push(`liq ${fmtUsd(m.liquidityUsd)}, vol24 ${fmtUsd(m.volume.h24)}`);
  return { score: Math.round(s), ready, explanation: parts.join(' · ') };
}

export interface OpenPositionView {
  entryPriceSol: number;
  peakPriceSol: number;
  openedAt: number;
}

export type ExitKind = 'TAKE_PROFIT' | 'STOP_LOSS' | 'TRAILING_STOP' | 'TIME_STOP';

export function checkExit(
  p: OpenPositionView,
  markSol: number,
  now: number,
  cfg: Config,
): { kind: ExitKind; reason: string } | null {
  // Round to 1e-9 so an exact +20% / −10% move isn't missed by float error.
  const chg = Math.round((markSol / p.entryPriceSol - 1) * 1e9) / 1e9;
  const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
  if (chg >= cfg.takeProfitPct) return { kind: 'TAKE_PROFIT', reason: `Take profit: mark ${pct(chg)} ≥ ${pct(cfg.takeProfitPct)}` };
  if (chg <= -cfg.stopLossPct) return { kind: 'STOP_LOSS', reason: `Stop loss: mark ${pct(chg)} ≤ −${(cfg.stopLossPct * 100).toFixed(0)}%` };
  const peakGain = p.peakPriceSol / p.entryPriceSol - 1;
  if (cfg.trailingActivatePct != null && peakGain >= cfg.trailingActivatePct) {
    const fromPeak = markSol / p.peakPriceSol - 1;
    if (fromPeak <= -cfg.trailingDistancePct)
      return { kind: 'TRAILING_STOP', reason: `Trailing stop: peak was ${pct(peakGain)}, now ${pct(fromPeak)} from peak (mark ${pct(chg)})` };
  }
  const heldMin = (now - p.openedAt) / 60_000;
  if (heldMin >= cfg.maxHoldMinutes) return { kind: 'TIME_STOP', reason: `Time stop: held ${Math.round(heldMin)} min, mark ${pct(chg)}` };
  return null;
}
