import type { Config } from './config.ts';
import { LAMPORTS_PER_SOL } from './config.ts';

export type Side = 'BUY' | 'SELL';

export interface SimQuote {
  /** Quoted output in UI units: tokens for BUY, SOL for SELL. */
  outAmount: number;
  priceImpactPct: number;
  source: 'jupiter' | 'model';
  route: string;
}

export interface ExecInput {
  side: Side;
  /** SOL for BUY, tokens for SELL. */
  amountIn: number;
  /** Last displayed DexScreener price in SOL per token. Reference only — never the fill price. */
  markPriceSol: number;
  quote: SimQuote;
  rng: () => number;
}

export interface ExecResult {
  status: 'FILLED' | 'FAILED';
  failReason: string | null;
  /** Tokens for BUY, SOL for SELL. 0 when failed. */
  amountOut: number;
  /** Network fee in SOL (paid even when the transaction fails). */
  feeSol: number;
  quotedPriceSol: number;
  fillPriceSol: number | null;
  latencySlippageBps: number;
  /** Total adverse price vs the displayed mark (spread + impact + latency), bps. */
  slippageVsMarkBps: number | null;
}

/** Standard normal via Box–Muller using the injected RNG (deterministic in tests). */
export function gaussian(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function networkFeeSol(cfg: Pick<Config, 'baseFeeLamports' | 'priorityFeeLamports'>): number {
  return (cfg.baseFeeLamports + cfg.priorityFeeLamports) / LAMPORTS_PER_SOL;
}

/**
 * Fallback when Jupiter has no quote: constant-product AMM on DexScreener liquidity,
 * plus DEX fee and a modelled half-spread. Always worse than the displayed price.
 */
export function modelQuote(
  side: Side,
  amountIn: number,
  markPriceSol: number,
  liquidityUsd: number,
  solUsd: number,
  cfg: Pick<Config, 'fallbackSpreadBps' | 'fallbackDexFeeBps'>,
): SimQuote {
  const poolSideSol = liquidityUsd / 2 / solUsd;
  const inSol = side === 'BUY' ? amountIn : amountIn * markPriceSol;
  const afterFee = inSol * (1 - cfg.fallbackDexFeeBps / 10_000);
  const impact = afterFee / (poolSideSol + afterFee);
  const spread = cfg.fallbackSpreadBps / 2 / 10_000;
  const outSolValue = afterFee * (1 - impact) * (1 - spread);
  const outAmount = side === 'BUY' ? outSolValue / markPriceSol : outSolValue;
  return { outAmount, priceImpactPct: impact * 100, source: 'model', route: 'constant-product model' };
}

/**
 * Simulate landing a swap. Starts from a real (or modelled) quote, then applies:
 * random adverse latency drift, slippage-tolerance failure, random dropped transactions,
 * and network fees (charged on failures too).
 */
export function simulateSwap(
  input: ExecInput,
  cfg: Pick<
    Config,
    'slippageToleranceBps' | 'failureProbability' | 'latencySlippageMeanBps' | 'latencySlippageStdBps' | 'baseFeeLamports' | 'priorityFeeLamports'
  >,
): ExecResult {
  const { side, amountIn, quote, markPriceSol, rng } = input;
  const feeSol = networkFeeSol(cfg);
  const quotedPriceSol = side === 'BUY' ? amountIn / quote.outAmount : quote.outAmount / amountIn;
  const latencyBps = Math.max(0, cfg.latencySlippageMeanBps + cfg.latencySlippageStdBps * gaussian(rng));
  const fail = (failReason: string): ExecResult => ({
    status: 'FAILED',
    failReason,
    amountOut: 0,
    feeSol,
    quotedPriceSol,
    fillPriceSol: null,
    latencySlippageBps: latencyBps,
    slippageVsMarkBps: null,
  });

  if (!(quote.outAmount > 0) || !(amountIn > 0)) return fail('no executable quote');
  if (rng() < cfg.failureProbability) return fail('transaction dropped / blockhash expired (simulated)');
  if (latencyBps > cfg.slippageToleranceBps)
    return fail(`price moved ${latencyBps.toFixed(0)} bps before landing > ${cfg.slippageToleranceBps} bps tolerance`);

  const amountOut = quote.outAmount * (1 - latencyBps / 10_000);
  const fillPriceSol = side === 'BUY' ? amountIn / amountOut : amountOut / amountIn;
  const slippageVsMarkBps =
    side === 'BUY' ? (fillPriceSol / markPriceSol - 1) * 10_000 : (1 - fillPriceSol / markPriceSol) * 10_000;
  return {
    status: 'FILLED',
    failReason: null,
    amountOut,
    feeSol,
    quotedPriceSol,
    fillPriceSol,
    latencySlippageBps: latencyBps,
    slippageVsMarkBps,
  };
}
