import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Config } from './config.ts';
import { ROOT } from './config.ts';
import type { Store } from './db.ts';
import { maxDrawdown, tradeStats } from './accounting.ts';
import { rulesFor } from './risk.ts';

export const DISCLAIMER =
  'SIMULATED PAPER-TRADING RESULTS. No real funds, wallet or orders were used. Fills are modelled from live Jupiter quotes ' +
  'plus simulated latency slippage, network fees and failed transactions; real execution (MEV, congestion, rugs between ' +
  'quote and fill, tax/accounting effects) can be materially worse. Past simulated performance does not predict real results.';

export function buildReport(store: Store, expId: number, now: number, cfg: Config) {
  const exp = store.experimentById(expId)!;
  const rules = rulesFor(exp, cfg);
  const eq = store.equity(expId);
  const last = eq[eq.length - 1];
  const closed = store.closedPositions(expId);
  const open = store.openPositions(expId);
  const stats = tradeStats(closed.map((p) => ({ netPnlIsk: p.netPnlIsk ?? 0 })));
  const totals = store.tradeTotals(expId);
  const dd = maxDrawdown(eq);
  const finalEquity = last?.equityIsk ?? exp.initialIsk;
  const solHold = last?.solHoldIsk ?? exp.initialIsk;
  const ret = finalEquity / exp.initialIsk - 1;
  const solRet = solHold / exp.initialIsk - 1;

  const days = store.dayStarts(expId).map((d, i, arr) => {
    const next = arr[i + 1]?.equityIsk ?? finalEquity;
    return { day: d.day, startEquityIsk: d.equityIsk, endEquityIsk: next, pnlIsk: next - d.equityIsk };
  });
  const byExit: Record<string, { count: number; netIsk: number }> = {};
  for (const p of closed) {
    const k = p.exitKind ?? 'UNKNOWN';
    byExit[k] ??= { count: 0, netIsk: 0 };
    byExit[k].count++;
    byExit[k].netIsk += p.netPnlIsk ?? 0;
  }

  return {
    disclaimer: DISCLAIMER,
    experimentId: expId,
    status: exp.status,
    generatedAt: new Date(now).toISOString(),
    kind: exp.kind,
    period: { start: new Date(exp.startedAt).toISOString(), end: rules.endsAt != null ? new Date(rules.endsAt).toISOString() : exp.finishedAt ? new Date(exp.finishedAt).toISOString() : 'open-ended (continuous)' },
    haltReason: exp.haltReason,
    initialIsk: exp.initialIsk,
    finalEquityIsk: finalEquity,
    netPnlIsk: finalEquity - exp.initialIsk,
    returnPct: ret * 100,
    solHoldIsk: solHold,
    solHoldReturnPct: solRet * 100,
    excessVsSolPct: (ret - solRet) * 100,
    maxDrawdownPct: dd.pct * 100,
    maxDrawdownIsk: dd.isk,
    trades: { ...stats, profitFactor: Number.isFinite(stats.profitFactor) ? stats.profitFactor : null, openPositions: open.length },
    costs: {
      networkFeesIsk: totals.feeIsk,
      slippageAndSpreadIsk: totals.slippageIsk,
      totalIsk: totals.feeIsk + totals.slippageIsk,
      failedTransactions: totals.failed ?? 0,
      filledTransactions: totals.filled ?? 0,
    },
    byExit,
    days,
    assumptions: {
      maxPositionIsk: cfg.maxPositionIsk,
      maxOpenPositions: cfg.maxOpenPositions,
      takeProfitPct: cfg.takeProfitPct * 100,
      stopLossPct: cfg.stopLossPct * 100,
      dailyLossLimitIsk: rules.dailyLossLimitIsk ?? 'none (daily P/L recorded, no halt)',
      maxDrawdownHalt: rules.maxDrawdownPct != null ? `${(rules.maxDrawdownPct * 100).toFixed(0)}% below peak equity` : 'none',
      failureProbability: cfg.failureProbability,
      latencySlippage: `mean ${cfg.latencySlippageMeanBps} bps, sd ${cfg.latencySlippageStdBps} bps`,
      slippageToleranceBps: cfg.slippageToleranceBps,
      networkFeeLamports: cfg.baseFeeLamports + cfg.priorityFeeLamports,
      currency: 'Cash held in ISK; each trade converts ISK↔SOL at the live SOL/USD × USD/ISK reference rate (no FX spread modelled).',
    },
    closedPositions: closed.map((p) => ({
      symbol: p.symbol, token: p.tokenAddress, openedAt: new Date(p.openedAt).toISOString(), closedAt: p.closedAt ? new Date(p.closedAt).toISOString() : null,
      costIsk: p.costIsk, proceedsIsk: p.proceedsIsk, netPnlIsk: p.netPnlIsk, exit: p.exitKind, entryReason: p.entryReason, exitReason: p.exitReason,
    })),
  };
}

export type Report = ReturnType<typeof buildReport>;

const n0 = (x: number) => Math.round(x).toLocaleString('en-US');
const pct = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`;

export function reportMarkdown(r: Report): string {
  const verdict =
    r.trades.completed < 20
      ? 'Too few completed trades for a statistically meaningful conclusion.'
      : r.excessVsSolPct > 0 && r.netPnlIsk > 0
        ? 'The strategy beat holding SOL after all simulated costs in this window. Treat as a hypothesis, not proof.'
        : 'The strategy did not beat holding SOL after all simulated costs in this window.';
  return `# ${r.kind === 'continuous' ? 'Continuous' : 'Seven-day'} paper-trading report — experiment #${r.experimentId}

> **${r.disclaimer}**

Period: ${r.period.start} → ${r.period.end} (status: ${r.status})${r.haltReason ? `\n\n**${r.haltReason}**` : ''}

| Metric | Value |
|---|---|
| Starting capital | ${n0(r.initialIsk)} ISK |
| Final equity | ${n0(r.finalEquityIsk)} ISK |
| Net P/L (after all costs) | ${n0(r.netPnlIsk)} ISK (${pct(r.returnPct)}) |
| Buy-and-hold SOL | ${n0(r.solHoldIsk)} ISK (${pct(r.solHoldReturnPct)}) |
| Strategy vs SOL | ${pct(r.excessVsSolPct)} |
| Max drawdown | ${r.maxDrawdownPct.toFixed(2)}% (${n0(r.maxDrawdownIsk)} ISK) |
| Completed trades | ${r.trades.completed} (${r.trades.wins} W / ${r.trades.losses} L) |
| Win rate | ${(r.trades.winRate * 100).toFixed(1)}% |
| Avg win / avg loss | ${n0(r.trades.avgWinIsk)} / ${n0(r.trades.avgLossIsk)} ISK |
| Profit factor | ${r.trades.profitFactor == null ? '∞' : r.trades.profitFactor.toFixed(2)} |
| Network fees | ${n0(r.costs.networkFeesIsk)} ISK |
| Slippage + spread + impact | ${n0(r.costs.slippageAndSpreadIsk)} ISK |
| Failed transactions | ${r.costs.failedTransactions} of ${r.costs.failedTransactions + r.costs.filledTransactions} |

**Verdict:** ${verdict}

## Daily P/L
| Day (UTC) | Start | End | P/L |
|---|---|---|---|
${r.days.map((d) => `| ${d.day} | ${n0(d.startEquityIsk)} | ${n0(d.endEquityIsk)} | ${n0(d.pnlIsk)} |`).join('\n')}

## Exits by type
| Exit | Count | Net ISK |
|---|---|---|
${Object.entries(r.byExit).map(([k, v]) => `| ${k} | ${v.count} | ${n0(v.netIsk)} |`).join('\n')}

## Execution assumptions
${Object.entries(r.assumptions).map(([k, v]) => `- **${k}**: ${v}`).join('\n')}

## Trades
| Token | Opened | Closed | Cost | Proceeds | Net | Exit |
|---|---|---|---|---|---|---|
${r.closedPositions.map((p) => `| ${p.symbol} | ${p.openedAt} | ${p.closedAt} | ${n0(p.costIsk)} | ${n0(p.proceedsIsk ?? 0)} | ${n0(p.netPnlIsk ?? 0)} | ${p.exit} |`).join('\n')}
`;
}

export function writeReport(r: Report, name: string): { json: string; md: string } {
  const dir = process.env.REPORTS_DIR ?? resolve(ROOT, 'reports');
  mkdirSync(dir, { recursive: true });
  const json = resolve(dir, `${name}.json`);
  const md = resolve(dir, `${name}.md`);
  writeFileSync(json, JSON.stringify(r, null, 2));
  writeFileSync(md, reportMarkdown(r));
  return { json, md };
}

export function finalizeExperiment(store: Store, expId: number, now: number, cfg: Config, status: 'finished' | 'halted' = 'finished') {
  store.updateExperiment(expId, { status, finishedAt: now });
  const r = buildReport(store, expId, now, cfg);
  store.updateExperiment(expId, { reportJson: JSON.stringify(r) });
  if (!process.env.NO_REPORT_FILES) writeReport(r, `experiment-${expId}-final`);
  return r;
}
