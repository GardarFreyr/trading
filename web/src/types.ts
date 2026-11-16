export interface Feed {
  feed: string;
  lastOk: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  latencyMs: number | null;
  okCount: number;
  errCount: number;
}

export interface Token {
  address: string;
  symbol: string;
  name: string;
  status: 'watching' | 'rejected' | 'unsafe';
  rejectReason: string | null;
  score: number | null;
  explanation: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24h: number | null;
  change1h: number | null;
  change5m: number | null;
  safety: { top10Pct: number; mintAuthority: string | null; freezeAuthority: string | null } | null;
}

export interface Position {
  id: number;
  tokenAddress: string;
  symbol: string;
  openedAt: number;
  closedAt: number | null;
  tokenAmount: number;
  costIsk: number;
  entryPriceSol: number;
  entryMarkSol: number;
  peakPriceSol: number;
  entryReason: string;
  exitReason: string | null;
  exitKind: string | null;
  proceedsIsk: number | null;
  extraFeesIsk: number;
  netPnlIsk: number | null;
  markSol?: number;
  markFresh?: boolean;
  valueIsk?: number | null;
  unrealizedIsk?: number | null;
  changePct?: number;
}

export interface Trade {
  id: number;
  positionId: number | null;
  ts: number;
  side: 'BUY' | 'SELL';
  status: 'FILLED' | 'FAILED';
  symbol: string;
  tokenAddress: string;
  quoteSource: string;
  route: string;
  markPriceSol: number;
  quotedPriceSol: number;
  fillPriceSol: number | null;
  solAmount: number;
  tokenAmount: number;
  iskAmount: number;
  feeIsk: number;
  priceImpactPct: number;
  latencySlippageBps: number;
  slippageVsMarkBps: number | null;
  slippageIsk: number;
  reason: string;
  failReason: string | null;
  assumptions: string;
}

export interface ExperimentSummary {
  id: number;
  kind: 'seven_day' | 'continuous';
  status: 'running' | 'finished' | 'halted';
  startedAt: number;
  endsAt: number | null;
  finishedAt: number | null;
  initialIsk: number;
  botStatus: string;
}

export interface State {
  disclaimer: string;
  now: number;
  experiments: ExperimentSummary[];
  bot: { status: string; detail: string; lastTickAt: number; tickMs: number; pollSeconds: number };
  data: { healthy: boolean; problems: string[]; solUsd: number | null; iskPerUsd: number | null; fxAsOf: number; feeds: Feed[] };
  config: {
    maxPositionIsk: number;
    maxOpenPositions: number;
    takeProfitPct: number;
    stopLossPct: number;
    /** null = the selected experiment has no daily loss halt (daily P/L is still recorded). */
    dailyLossLimitIsk: number | null;
    /** null = no total-drawdown halt for the selected experiment. Fraction (0.2 = 20%). */
    maxDrawdownPct: number | null;
    trailingActivatePct: number | null;
    trailingDistancePct: number;
    maxHoldMinutes: number;
    minEntryScore: number;
    failureProbability: number;
  };
  tokens: Token[];
  events: { id: number; ts: number; level: string; message: string }[];
  experiment: null | {
    id: number;
    kind: 'seven_day' | 'continuous';
    status: 'running' | 'finished' | 'halted';
    startedAt: number;
    /** null = continuous (no end date). */
    endsAt: number | null;
    finishedAt: number | null;
    haltedAt: number | null;
    haltReason: string | null;
    peakEquityIsk: number;
    currentDrawdownPct: number;
    initialIsk: number;
    cashIsk: number;
    equityIsk: number;
    positionsIsk: number;
    totalPnlIsk: number;
    dailyPnlIsk: number;
    dailyLossUsedIsk: number;
    solHoldIsk: number;
    drawdown: { pct: number; isk: number; peakIsk: number };
    stats: { completed: number; wins: number; losses: number; winRate: number; avgWinIsk: number; avgLossIsk: number; profitFactor: number | null };
    costs: { feesIsk: number; slippageIsk: number; failed: number; filled: number };
    equity: { ts: number; equityIsk: number; solHoldIsk: number }[];
    openPositions: Position[];
    closedPositions: Position[];
    trades: Trade[];
    hasFinalReport: boolean;
  };
}
