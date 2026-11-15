export interface EquityPoint {
  ts: number;
  equityIsk: number;
}

export function positionValueIsk(tokenAmount: number, markPriceSol: number, solIsk: number): number {
  return tokenAmount * markPriceSol * solIsk;
}

export function maxDrawdown(series: EquityPoint[]): { pct: number; isk: number; peakIsk: number } {
  let peak = -Infinity;
  let best = { pct: 0, isk: 0, peakIsk: series[0]?.equityIsk ?? 0 };
  for (const p of series) {
    if (p.equityIsk > peak) peak = p.equityIsk;
    const dd = peak - p.equityIsk;
    const pct = peak > 0 ? dd / peak : 0;
    if (pct > best.pct) best = { pct, isk: dd, peakIsk: peak };
  }
  return best;
}

export interface ClosedPositionStat {
  netPnlIsk: number;
}

export function tradeStats(closed: ClosedPositionStat[]) {
  const wins = closed.filter((p) => p.netPnlIsk > 0);
  const losses = closed.filter((p) => p.netPnlIsk <= 0);
  const grossWin = wins.reduce((s, p) => s + p.netPnlIsk, 0);
  const grossLoss = -losses.reduce((s, p) => s + p.netPnlIsk, 0);
  return {
    completed: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? wins.length / closed.length : 0,
    avgWinIsk: wins.length ? grossWin / wins.length : 0,
    avgLossIsk: losses.length ? -grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : wins.length ? Infinity : 0,
    netIsk: grossWin - grossLoss,
  };
}

/** Buy cost: SOL spent (input + network fee) converted at the SOL/ISK reference rate. */
export function buyCostIsk(solIn: number, feeSol: number, solIsk: number): number {
  return (solIn + feeSol) * solIsk;
}

/** Sell proceeds net of network fee. */
export function sellProceedsIsk(solOut: number, feeSol: number, solIsk: number): number {
  return (solOut - feeSol) * solIsk;
}

export function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}
