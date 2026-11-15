import { Fragment, useId, useMemo, useState, type ComponentProps, type ReactNode } from 'react';
import { Area, AreaChart, CartesianGrid, Line, XAxis, YAxis } from 'recharts';
import {
  AlertTriangleIcon,
  ArrowDownRightIcon,
  ArrowUpRightIcon,
  CircleDotIcon,
  InfoIcon,
  XCircleIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Delta, DeltaIcon, DeltaValue } from '@/components/delta';
import { StatusIndicator } from '@/components/indicator';
import type { Feed, Position, State, Token, Trade } from '../types';
import { ago, dateTime, duration, isk, pct, price, time, tone, usd } from '../format';

const cardCls = 'shadow-none dark:ring-0';
type Exp = NonNullable<State['experiment']>;

// ---------- Stats (same anatomy as the block's DashboardStats) ----------

export type Stat = { label: string; value: ReactNode; delta?: number; footnote: string; valueCls?: string };

export function StatCard({ s }: { s: Stat }) {
  return (
    <Card className={cardCls}>
      <CardHeader>
        <CardTitle className="text-xs font-normal text-muted-foreground">{s.label}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className={cn('text-2xl font-semibold tabular-nums', s.valueCls)}>{s.value}</p>
        <div className="flex items-center gap-1 text-xs">
          {s.delta != null && (
            <Delta value={s.delta}>
              <DeltaIcon />
              <DeltaValue precision={2} />
            </Delta>
          )}
          <span className="text-muted-foreground">{s.footnote}</span>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- Equity chart (same anatomy as ConversationVolumeChart) ----------

const equityConfig = {
  bot: { label: 'Bot equity', color: 'var(--chart-2)' },
  sol: { label: 'Hold SOL', color: 'var(--chart-1)' },
} satisfies ChartConfig;

type Range = '24h' | '72h' | 'all';

export function EquityCard({ e, className, ...props }: { e: Exp } & ComponentProps<typeof Card>) {
  const uid = useId().replace(/:/g, '');
  const [range, setRange] = useState<Range>('all');
  const rows = useMemo(() => {
    const pts = e.equity.map((p) => ({ ts: p.ts, bot: p.equityIsk, sol: p.solHoldIsk }));
    if (range === 'all' || pts.length === 0) return pts;
    const from = pts[pts.length - 1].ts - (range === '24h' ? 24 : 72) * 3_600_000;
    return pts.filter((p) => p.ts >= from);
  }, [e.equity, range]);
  const ret = (e.equityIsk / e.initialIsk - 1) * 100;
  const span = rows.length > 1 ? rows[rows.length - 1].ts - rows[0].ts : 0;

  return (
    <Card className={cn(cardCls, 'md:col-span-2 lg:col-span-3', className)} {...props}>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>Portfolio performance</CardTitle>
            <Delta value={ret} variant="badge">
              <DeltaIcon variant="trend" />
              <DeltaValue precision={2} />
            </Delta>
          </div>
          <CardDescription>Simulated equity in ISK after all costs, against buying and holding SOL.</CardDescription>
        </div>
        <Select onValueChange={(v) => setRange(v as Range)} value={range}>
          <SelectTrigger aria-label="Performance time range" className="w-full min-w-36 sm:w-fit" size="sm">
            <SelectValue placeholder="Range" />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="24h">Last 24 hours</SelectItem>
            <SelectItem value="72h">Last 3 days</SelectItem>
            <SelectItem value="all">Whole experiment</SelectItem>
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent>
        {rows.length < 2 ? (
          <div className="flex aspect-22/8 w-full items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            The chart starts after the first minute of the experiment.
          </div>
        ) : (
          <ChartContainer className="aspect-22/8 w-full" config={equityConfig}>
            <AreaChart accessibilityLayer data={rows} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
              <defs>
                <linearGradient id={`eq-${uid}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-bot)" stopOpacity={0.45} />
                  <stop offset="55%" stopColor="var(--color-bot)" stopOpacity={0.12} />
                  <stop offset="100%" stopColor="var(--color-bot)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid className="stroke-border" vertical={false} />
              <XAxis
                axisLine={false}
                dataKey="ts"
                domain={['dataMin', 'dataMax']}
                minTickGap={40}
                scale="time"
                tickFormatter={(v: number) =>
                  span > 36 * 3_600_000
                    ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
                    : new Date(v).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
                }
                tickLine={false}
                tickMargin={8}
                type="number"
              />
              <YAxis
                axisLine={false}
                domain={['auto', 'auto']}
                tick={{ className: 'tabular-nums' }}
                tickFormatter={(v: number) => Math.round(v).toLocaleString('en-US')}
                tickLine={false}
                tickMargin={8}
                width={52}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    className="min-w-40"
                    formatter={(value, name) => (
                      <div className="flex w-full justify-between gap-4">
                        <span className="text-muted-foreground">{equityConfig[name as 'bot' | 'sol']?.label}</span>
                        <span className="num">{isk(Number(value))}</span>
                      </div>
                    )}
                    indicator="line"
                    labelFormatter={(_, payload) => {
                      const ts = payload?.[0]?.payload?.ts as number | undefined;
                      return ts ? dateTime(ts) : '';
                    }}
                  />
                }
                cursor={false}
              />
              <Area dataKey="bot" dot={false} fill={`url(#eq-${uid})`} stroke="var(--color-bot)" strokeWidth={2} type="monotone" />
              <Line dataKey="sol" dot={false} stroke="var(--color-sol)" strokeDasharray="5 4" strokeWidth={1.5} type="monotone" />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

// ---------- Risk (same anatomy as ChannelBreakdownChart: labelled bars) ----------

function Meter({ label, value, max, display, barCls }: { label: string; value: number; max: number; display: string; barCls: string }) {
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="num">{display}</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted">
        <div className={cn('h-1.5 rounded-full', barCls)} style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
      </div>
    </div>
  );
}

export function RiskCard({ e, cfg, className }: { e: Exp; cfg: State['config'] } & ComponentProps<typeof Card>) {
  const lossHit = e.dailyLossUsedIsk >= cfg.dailyLossLimitIsk;
  return (
    <Card className={cn(cardCls, className)}>
      <CardHeader className="border-b">
        <CardTitle>Risk limits</CardTitle>
        <CardDescription>Hard limits enforced by the engine</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Meter
          barCls={lossHit ? 'bg-red-500' : 'bg-amber-500'}
          display={`${Math.round(e.dailyLossUsedIsk)} / ${cfg.dailyLossLimitIsk} ISK`}
          label="Daily loss used"
          max={cfg.dailyLossLimitIsk}
          value={e.dailyLossUsedIsk}
        />
        <Meter
          barCls="bg-sky-500"
          display={`${e.openPositions.length} / ${cfg.maxOpenPositions}`}
          label="Open positions"
          max={cfg.maxOpenPositions}
          value={e.openPositions.length}
        />
        <Meter
          barCls="bg-[var(--chart-4)]"
          display={pct(-e.drawdown.pct * 100)}
          label="Max drawdown"
          max={0.2}
          value={e.drawdown.pct}
        />
        <dl className="num grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
          <dt className="text-muted-foreground">Max position</dt>
          <dd className="text-right">{isk(cfg.maxPositionIsk)}</dd>
          <dt className="text-muted-foreground">Take profit</dt>
          <dd className="text-right text-emerald-500">+{cfg.takeProfitPct * 100}%</dd>
          <dt className="text-muted-foreground">Stop loss</dt>
          <dd className="text-right text-rose-500">−{cfg.stopLossPct * 100}%</dd>
          {cfg.trailingActivatePct != null && (
            <>
              <dt className="text-muted-foreground">Trailing stop</dt>
              <dd className="text-right">
                +{Math.round(cfg.trailingActivatePct * 100)}% / {Math.round(cfg.trailingDistancePct * 100)}%
              </dd>
            </>
          )}
          <dt className="text-muted-foreground">Time stop</dt>
          <dd className="text-right">{cfg.maxHoldMinutes} min</dd>
          <dt className="text-muted-foreground">Failed tx (sim)</dt>
          <dd className="text-right">
            {e.costs.failed} of {e.costs.failed + e.costs.filled}
          </dd>
        </dl>
      </CardContent>
    </Card>
  );
}

// ---------- Active positions ----------

export function PositionsCard({ e, cfg, now, className }: { e: Exp; cfg: State['config']; now: number } & ComponentProps<typeof Card>) {
  return (
    <Card className={cn(cardCls, 'gap-0 md:col-span-2', className)} id="positions">
      <CardHeader className="border-b">
        <CardTitle>Active positions</CardTitle>
        <CardDescription>
          {e.openPositions.length} of {cfg.maxOpenPositions} slots in use · up to {isk(cfg.maxPositionIsk)} each
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {e.openPositions.length === 0 ? (
          <p className="px-6 py-10 text-center text-sm text-muted-foreground">No open positions. The bot is scanning for entries.</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {e.openPositions.map((p) => (
              <PositionRow cfg={cfg} key={p.id} now={now} p={p} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function PositionRow({ p, cfg, now }: { p: Position; cfg: State['config']; now: number }) {
  const chg = p.changePct ?? 0;
  const tp = cfg.takeProfitPct;
  const sl = cfg.stopLossPct;
  const at = Math.max(0, Math.min(1, (chg / 100 + sl) / (tp + sl)));
  return (
    <li className="flex flex-col gap-3 px-6 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-medium">{p.symbol}</span>
          <Delta value={chg} variant="badge">
            <DeltaIcon variant="trend" />
            <DeltaValue />
          </Delta>
          {!p.markFresh && <Badge variant="outline">stale price</Badge>}
        </div>
        <span className={cn('num text-sm font-medium', tone(p.unrealizedIsk))}>{isk(p.unrealizedIsk, true)} net</span>
      </div>
      <div className="num grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
        <span>Cost {isk(p.costIsk)}</span>
        <span>Value {isk(p.valueIsk)}</span>
        <span>Entry {price(p.entryPriceSol)} SOL</span>
        <span>Held {duration(now - p.openedAt)}</span>
      </div>
      <div>
        <div className="relative h-1.5 rounded-full bg-gradient-to-r from-rose-500/40 via-muted to-emerald-500/40">
          <div className="absolute -top-1 h-3.5 w-3.5 -translate-x-1/2 rounded-full border-2 border-background bg-foreground" style={{ left: `${at * 100}%` }} />
        </div>
        <div className="num mt-1 flex justify-between text-[10px] text-muted-foreground">
          <span>SL −{sl * 100}%</span>
          <span>TP +{tp * 100}%</span>
        </div>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        <span className="text-foreground">Why entered: </span>
        {p.entryReason}
      </p>
    </li>
  );
}

// ---------- Bot & data feeds (same anatomy as TeamOnDuty: list with status indicators) ----------

const FEED_LABEL: Record<string, string> = {
  'dexscreener-prices': 'DexScreener prices',
  'dexscreener-discovery': 'Token discovery',
  jupiter: 'Jupiter quotes',
  'solana-rpc': 'Solana RPC',
  fx: 'USD/ISK rate',
};

export function FeedsCard({ s, now, className }: { s: State; now: number } & ComponentProps<typeof Card>) {
  return (
    <Card className={cn(cardCls, className)} id="feeds">
      <CardHeader className="border-b">
        <CardTitle>Data feed health</CardTitle>
        <CardDescription>{s.data.healthy ? 'All required feeds are fresh' : `Trading paused: ${s.data.problems.join('; ')}`}</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="flex flex-col divide-y">
          {s.data.feeds.map((f: Feed) => {
            const ok = !!f.lastOk && (!f.lastErrorAt || f.lastOk > f.lastErrorAt);
            const recentErr = ok && f.errCount > 0 && !!f.lastErrorAt && now - f.lastErrorAt < 600_000;
            return (
              <li className="flex items-center gap-3 px-6 py-3" key={f.feed}>
                <StatusIndicator color={!ok ? 'rose' : recentErr ? 'amber' : 'emerald'} pulse={ok && !recentErr} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{FEED_LABEL[f.feed] ?? f.feed}</p>
                  <p className="truncate text-xs text-muted-foreground" title={f.lastError ?? undefined}>
                    {!ok && f.lastError ? f.lastError : `${f.okCount} ok · ${f.errCount} errors`}
                  </p>
                </div>
                <span className="num shrink-0 text-xs text-muted-foreground">
                  {ago(f.lastOk, now)}
                  {f.latencyMs != null ? ` · ${f.latencyMs}ms` : ''}
                </span>
              </li>
            );
          })}
          <li className="num flex justify-between px-6 py-3 text-xs text-muted-foreground">
            <span>Engine tick</span>
            <span>
              {ago(s.bot.lastTickAt, now)} · {s.bot.tickMs}ms
            </span>
          </li>
        </ul>
      </CardContent>
    </Card>
  );
}

// ---------- Activity (same anatomy as SupportActivity) ----------

function eventIcon(level: string, message: string) {
  if (level === 'error') return <XCircleIcon className="text-rose-500" />;
  if (level === 'warn') return <AlertTriangleIcon className="text-amber-500" />;
  if (level === 'trade') return message.startsWith('BUY') ? <ArrowUpRightIcon className="text-emerald-500" /> : <ArrowDownRightIcon className="text-sky-500" />;
  if (message.startsWith('Status')) return <CircleDotIcon />;
  return <InfoIcon className="text-muted-foreground" />;
}

export function ActivityCard({ s, now, className }: { s: State; now: number } & ComponentProps<typeof Card>) {
  return (
    <Card className={cn(cardCls, 'gap-0', className)}>
      <CardHeader className="border-b">
        <CardTitle>Bot activity</CardTitle>
        <CardDescription>Decisions, skips and status changes</CardDescription>
      </CardHeader>
      <CardContent className="max-h-[480px] overflow-y-auto px-0">
        <ul className="flex flex-col divide-y">
          {s.events.slice(0, 25).map((ev) => (
            <li className="flex items-center gap-3 px-3 py-3" key={ev.id}>
              <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center [&_svg]:size-4">
                {eventIcon(ev.level, ev.message)}
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <p className="line-clamp-2 text-xs leading-snug text-pretty text-foreground">{ev.message}</p>
                <p className="num text-xs text-muted-foreground">
                  {time(ev.ts)} · {ago(ev.ts, now)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

// ---------- Transactions (same anatomy as RecentConversations) ----------

export function TransactionsCard({ trades, className }: { trades: Trade[] } & ComponentProps<typeof Card>) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <Card className={cn(cardCls, 'gap-0 sm:col-span-2 lg:col-span-4', className)} id="transactions">
      <CardHeader className="border-b">
        <CardTitle>Recent transactions</CardTitle>
        <CardDescription>Every row is a simulated execution priced from a live quote. Select a row for its assumptions.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {trades.length === 0 ? (
          <p className="px-6 py-10 text-center text-sm text-muted-foreground">No simulated executions yet.</p>
        ) : (
          <div className="max-h-[520px] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-6">Time</TableHead>
                  <TableHead>Token</TableHead>
                  <TableHead>Side</TableHead>
                  <TableHead className="text-right">ISK</TableHead>
                  <TableHead className="text-right">Fill vs mark</TableHead>
                  <TableHead className="text-right">Fee</TableHead>
                  <TableHead className="hidden lg:table-cell">Reason</TableHead>
                  <TableHead className="pr-6 text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trades.map((t) => {
                  const failed = t.status === 'FAILED';
                  const a = JSON.parse(t.assumptions);
                  return (
                    <Fragment key={t.id}>
                      <TableRow className="h-14 cursor-pointer" onClick={() => setOpen(open === t.id ? null : t.id)}>
                        <TableCell className="num pl-6 text-muted-foreground">{dateTime(t.ts)}</TableCell>
                        <TableCell className="font-medium">{t.symbol}</TableCell>
                        <TableCell>
                          <span className={cn('text-sm font-medium', t.side === 'BUY' ? 'text-emerald-500' : 'text-sky-500')}>{t.side}</span>
                        </TableCell>
                        <TableCell className="num text-right">{failed ? '—' : Math.round(Math.abs(t.iskAmount)).toLocaleString('en-US')}</TableCell>
                        <TableCell className="num text-right text-muted-foreground">{t.slippageVsMarkBps == null ? '—' : `${t.slippageVsMarkBps.toFixed(0)} bps`}</TableCell>
                        <TableCell className="num text-right text-muted-foreground">{t.feeIsk.toFixed(1)}</TableCell>
                        <TableCell className="hidden max-w-[420px] lg:table-cell">
                          <span className="line-clamp-1 text-sm text-muted-foreground">{failed ? t.failReason : t.reason}</span>
                        </TableCell>
                        <TableCell className="pr-6 text-right">
                          <Badge variant={failed ? 'destructive' : t.quoteSource === 'model' ? 'outline' : 'secondary'}>
                            {failed ? 'Failed' : t.quoteSource === 'model' ? 'Filled (model)' : 'Filled'}
                          </Badge>
                        </TableCell>
                      </TableRow>
                      {open === t.id && (
                        <TableRow className="bg-muted/40 hover:bg-muted/40">
                          <TableCell className="px-6 py-4 whitespace-normal" colSpan={8}>
                            <p className="mb-2 text-sm">{failed ? `Failed: ${t.failReason}` : t.reason}</p>
                            <div className="num grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-6 gap-y-1 text-xs text-muted-foreground">
                              <span>Quote: {t.quoteSource} ({t.route})</span>
                              <span>Displayed price: {price(t.markPriceSol)} SOL</span>
                              <span>Quoted price: {price(t.quotedPriceSol)} SOL</span>
                              <span>Fill price: {price(t.fillPriceSol)} SOL</span>
                              <span>Price impact: {t.priceImpactPct.toFixed(2)}%</span>
                              <span>Latency drift: {t.latencySlippageBps.toFixed(0)} bps</span>
                              <span>Slippage cost: {t.slippageIsk.toFixed(1)} ISK</span>
                              <span>Network fee: {t.feeIsk.toFixed(2)} ISK</span>
                              {a.fx && (
                                <span>
                                  SOL ${a.fx.solUsd?.toFixed(2)} · USD/ISK {a.fx.iskPerUsd?.toFixed(2)}
                                </span>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------- Completed trades ----------

export function CompletedCard({ e, className }: { e: Exp } & ComponentProps<typeof Card>) {
  return (
    <Card className={cn(cardCls, 'gap-0 sm:col-span-2 lg:col-span-4', className)} id="completed">
      <CardHeader className="border-b">
        <CardTitle>Completed trades</CardTitle>
        <CardDescription>
          {e.stats.completed} closed · avg win {isk(e.stats.avgWinIsk)} · avg loss {isk(e.stats.avgLossIsk)} · net after every fee and slippage
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {e.closedPositions.length === 0 ? (
          <p className="px-6 py-10 text-center text-sm text-muted-foreground">No completed trades yet.</p>
        ) : (
          <div className="max-h-[480px] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-6">Token</TableHead>
                  <TableHead>Opened</TableHead>
                  <TableHead>Held</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Net P/L</TableHead>
                  <TableHead className="hidden md:table-cell">Exit reason</TableHead>
                  <TableHead className="pr-6 text-right">Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {e.closedPositions.map((p) => {
                  const win = (p.netPnlIsk ?? 0) > 0;
                  return (
                    <TableRow className="h-14 hover:bg-transparent" key={p.id}>
                      <TableCell className="pl-6 font-medium">{p.symbol}</TableCell>
                      <TableCell className="num text-muted-foreground">{dateTime(p.openedAt)}</TableCell>
                      <TableCell className="num text-muted-foreground">{p.closedAt ? duration(p.closedAt - p.openedAt) : '—'}</TableCell>
                      <TableCell className="num text-right">{Math.round(p.costIsk).toLocaleString('en-US')}</TableCell>
                      <TableCell className={cn('num text-right font-medium', tone(p.netPnlIsk))}>{isk(p.netPnlIsk, true)}</TableCell>
                      <TableCell className="hidden max-w-[380px] md:table-cell">
                        <span className="line-clamp-1 text-sm text-muted-foreground">{p.exitReason}</span>
                      </TableCell>
                      <TableCell className="pr-6 text-right">
                        <Badge className={win ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/10 text-red-500'} variant="secondary">
                          {win ? 'Win' : 'Loss'}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------- Monitored tokens ----------

export function TokensCard({ tokens, min, className }: { tokens: Token[]; min: number } & ComponentProps<typeof Card>) {
  const watching = tokens.filter((t) => t.status === 'watching').sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const others = tokens.filter((t) => t.status !== 'watching');
  const rows = [...watching, ...others];
  return (
    <Card className={cn(cardCls, 'gap-0 sm:col-span-2 lg:col-span-4', className)} id="tokens">
      <CardHeader className="border-b">
        <CardTitle>Monitored tokens</CardTitle>
        <CardDescription>
          {watching.length} pass the filters · {others.length} filtered out · entry needs a score of {min} or more and 5 minutes of observations
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <div className="max-h-[560px] overflow-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-6">Token</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">Liquidity</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Vol 24h</TableHead>
                <TableHead className="text-right">1h</TableHead>
                <TableHead className="text-right">Score</TableHead>
                <TableHead className="hidden lg:table-cell">Analysis</TableHead>
                <TableHead className="pr-6 text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((t) => {
                const ok = t.status === 'watching';
                const waiting = t.explanation?.startsWith('[waiting]');
                const ready = ok && !waiting && (t.score ?? 0) >= min;
                return (
                  <TableRow className="h-12 hover:bg-transparent" key={t.address}>
                    <TableCell className="pl-6 font-medium">
                      <a className="hover:underline" href={`https://dexscreener.com/solana/${t.address}`} rel="noreferrer" target="_blank" title={t.name}>
                        {t.symbol}
                      </a>
                    </TableCell>
                    <TableCell className="num text-right">{t.priceUsd != null ? `$${price(t.priceUsd)}` : '—'}</TableCell>
                    <TableCell className="num text-right text-muted-foreground">{usd(t.liquidityUsd)}</TableCell>
                    <TableCell className="num hidden text-right text-muted-foreground sm:table-cell">{usd(t.volume24h)}</TableCell>
                    <TableCell className={cn('num text-right', tone(t.change1h))}>{pct(t.change1h, 1)}</TableCell>
                    <TableCell className={cn('num text-right', ready ? 'font-semibold text-emerald-500' : 'text-muted-foreground')}>
                      {ok ? (t.score ?? '—') : '—'}
                    </TableCell>
                    <TableCell className="hidden max-w-[440px] lg:table-cell">
                      <span className="line-clamp-1 text-sm text-muted-foreground">{ok ? t.explanation?.replace('[waiting] ', '') : t.rejectReason}</span>
                    </TableCell>
                    <TableCell className="pr-6 text-right">
                      <Badge variant={t.status === 'unsafe' ? 'destructive' : ready ? 'default' : ok ? 'secondary' : 'outline'}>
                        {t.status === 'unsafe' ? 'Unsafe' : !ok ? 'Filtered' : waiting ? 'Observing' : ready ? 'Entry signal' : 'Watching'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
