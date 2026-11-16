import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * All strategy, risk and execution-simulation parameters.
 * Override any of them in `config.local.json` at the project root (see config.example.json).
 */
export interface Config {
  // Experiment
  initialCapitalIsk: number;
  experimentDays: number;

  // Risk limits
  maxPositionIsk: number;
  maxOpenPositions: number;
  dailyLossLimitIsk: number;
  /** Continuous experiments only: halt and liquidate once equity is this far below its peak (0.2 = 20%). */
  continuousMaxDrawdownPct: number;
  reentryCooldownMinutes: number;

  // Exits
  takeProfitPct: number;
  stopLossPct: number;
  /** Trailing stop arms once the position is up this much (null = disabled). */
  trailingActivatePct: number | null;
  /** Once armed, exit if price falls this far from its peak. */
  trailingDistancePct: number;
  maxHoldMinutes: number;

  // Entry
  minEntryScore: number;
  /** Minutes of our OWN forward price observations required before a token may be bought. */
  minObservationMinutes: number;

  // Token filters
  minLiquidityUsd: number;
  minVolume24hUsd: number;
  minPairAgeHours: number;
  maxPairAgeDays: number;
  minTxnsH1: number;
  maxPriceChangeH1Pct: number;
  minLiquidityToFdv: number;
  maxTop10HolderPct: number;
  /** Reject if a buy-then-sell Jupiter quote round trip loses more than this (taxes / honeypots / thin routes). */
  maxRoundTripLossPct: number;
  /** If on-chain safety data can't be fetched, refuse to trade the token. */
  requireSafetyData: boolean;

  // Execution simulation
  slippageToleranceBps: number;
  baseFeeLamports: number;
  priorityFeeLamports: number;
  failureProbability: number;
  latencySlippageMeanBps: number;
  latencySlippageStdBps: number;
  /** Used only when no Jupiter quote is available: modelled spread on top of constant-product price impact. */
  fallbackSpreadBps: number;
  fallbackDexFeeBps: number;
  allowModelledFills: boolean;

  // Data / timing
  pollSeconds: number;
  discoverySeconds: number;
  priceStaleSeconds: number;
  fxStaleHours: number;
  maxWatchlist: number;
  equitySnapshotSeconds: number;

  // Endpoints
  dexscreenerBase: string;
  jupiterQuoteUrl: string;
  solanaRpcUrl: string;
  fxUrl: string;
  /** Extra token discovery (addresses only). Empty string disables. */
  trendingDiscoveryUrl: string;

  port: number;
  dbPath: string;
}

export const defaultConfig: Config = {
  initialCapitalIsk: 10_000,
  experimentDays: 7,

  maxPositionIsk: 700,
  maxOpenPositions: 2,
  dailyLossLimitIsk: 350,
  continuousMaxDrawdownPct: 0.2,
  reentryCooldownMinutes: 120,

  takeProfitPct: 0.2,
  stopLossPct: 0.1,
  trailingActivatePct: 0.12,
  trailingDistancePct: 0.07,
  maxHoldMinutes: 240,

  minEntryScore: 65,
  minObservationMinutes: 5,

  minLiquidityUsd: 40_000,
  minVolume24hUsd: 100_000,
  minPairAgeHours: 2,
  maxPairAgeDays: 60,
  minTxnsH1: 150,
  maxPriceChangeH1Pct: 150,
  minLiquidityToFdv: 0.03,
  maxTop10HolderPct: 50,
  maxRoundTripLossPct: 6,
  requireSafetyData: true,

  slippageToleranceBps: 300,
  baseFeeLamports: 5_000,
  priorityFeeLamports: 200_000,
  failureProbability: 0.05,
  latencySlippageMeanBps: 25,
  latencySlippageStdBps: 40,
  fallbackSpreadBps: 100,
  fallbackDexFeeBps: 25,
  allowModelledFills: true,

  pollSeconds: 10,
  discoverySeconds: 90,
  priceStaleSeconds: 60,
  fxStaleHours: 48,
  maxWatchlist: 60,
  equitySnapshotSeconds: 60,

  dexscreenerBase: 'https://api.dexscreener.com',
  jupiterQuoteUrl: 'https://lite-api.jup.ag/swap/v1/quote',
  solanaRpcUrl: 'https://api.mainnet-beta.solana.com',
  fxUrl: 'https://open.er-api.com/v6/latest/USD',
  trendingDiscoveryUrl: 'https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1',

  port: 8787,
  dbPath: 'data/paper-trader.db',
};

export const ROOT = resolve(import.meta.dirname, '..', '..');

export function loadConfig(): Config {
  const file = resolve(ROOT, 'config.local.json');
  let overrides: Partial<Config> = {};
  if (existsSync(file)) overrides = JSON.parse(readFileSync(file, 'utf8'));
  const cfg = { ...defaultConfig, ...overrides };
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (process.env.DB_PATH) cfg.dbPath = process.env.DB_PATH;
  else if (volume) cfg.dbPath = `${volume.replace(/\/$/, '')}/paper-trader.db`;
  if (volume && !process.env.REPORTS_DIR) process.env.REPORTS_DIR = `${volume.replace(/\/$/, '')}/reports`;
  return cfg;
}

/** Where the deployment runs: 'railway' or 'local'. */
export const onRailway = (): boolean => !!(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);

/** Interface to listen on: all interfaces on Railway (behind its proxy), loopback locally. */
export const listenHost = (): string => process.env.HOST ?? (onRailway() ? '0.0.0.0' : '127.0.0.1');

/**
 * On Railway the database must live on the persistent volume; the container disk is wiped on every deploy.
 * Returns an error message if the configured path would lose data, else null.
 */
export function storageProblem(dbFile: string): string | null {
  if (!onRailway()) return null;
  const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (!volume) return 'Running on Railway without a volume (RAILWAY_VOLUME_MOUNT_PATH is not set). Attach the volume at /data; refusing to run on ephemeral disk.';
  const root = volume.replace(/\/$/, '') + '/';
  if (!dbFile.startsWith(root)) return `Database path ${dbFile} is not on the volume ${volume}; refusing to run on ephemeral disk.`;
  return null;
}

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const LAMPORTS_PER_SOL = 1_000_000_000;
