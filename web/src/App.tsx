import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExperimentSummary, State } from './types';
import { duration, isk, pct } from './format';
import { TraderShell, type StatusTone } from './trader/shell';
import {
  ActivityCard,
  cardCls,
  CompletedCard,
  EquityCard,
  FeedsCard,
  PositionsCard,
  KpiStrip,
  RiskCard,
  SummaryCard,
  TokensCard,
  TransactionsCard,
  type Stat,
} from './trader/cards';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Shimmer, SubtleNumber, TextsReveal, ToastStack, type ToastItem } from './trader/motion';
import { cn } from '@/lib/utils';
import { TradeDetailSheet } from './trader/trade-chart';

const STATUS: Record<string, { label: string; tone: StatusTone }> = {
  RUNNING: { label: 'Running', tone: 'emerald' },
  PAUSED_STALE_DATA: { label: 'Paused · stale data', tone: 'amber' },
  HALTED_DAILY_LOSS: { label: 'Halted · daily loss limit', tone: 'rose' },
  HALTED_DRAWDOWN: { label: 'Halted · 20% drawdown safety halt', tone: 'rose' },
  STANDBY: { label: 'Standby · another engine owns this data', tone: 'amber' },
  IDLE_NO_EXPERIMENT: { label: 'Idle', tone: 'sky' },
  FINISHED: { label: 'Finished', tone: 'sky' },
  STARTING: { label: 'Starting', tone: 'sky' },
};

function useHash() {
  const [hash, setHash] = useState(() => window.location.hash || '#overview');
  useEffect(() => {
    const on = () => {
      const h = window.location.hash || '#overview';
      setHash(h);
      document.getElementById(h.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export default function App() {
  const [s, setS] = useState<State | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [starting, setStarting] = useState(false);
  const [chartId, setChartId] = useState<number | null>(null);
  // Which experiment the dashboard shows (?exp=<id>); null = the engine's default (oldest running).
  const [selected, setSelected] = useState<number | null>(() => {
    const v = Number(new URLSearchParams(window.location.search).get('exp'));
    return Number.isInteger(v) && v > 0 ? v : null;
  });
  const selectedRef = useRef(selected);
  const choose = (id: number) => {
    selectedRef.current = id;
    setSelected(id);
    setChartId(null);
    const u = new URL(window.location.href);
    u.searchParams.set('exp', String(id));
    window.history.replaceState(null, '', u);
  };
  const hash = useHash();
  const toasts = useTradeToasts(s);
  // Skeleton (transitions.dev 14): pulses until the first state arrives, then cross-fades
  // to the content and is removed once the reveal has finished.
  const [skeletonGone, setSkeletonGone] = useState(false);
  useEffect(() => {
    if (!s || skeletonGone) return;
    const ms = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--reveal-dur')) || 400;
    const t = setTimeout(() => setSkeletonGone(true), ms + 50);
    return () => clearTimeout(t);
  }, [s, skeletonGone]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const want = selectedRef.current;
        const r = await fetch(want == null ? '/api/state' : `/api/state?experiment=${want}`, { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as State;
        if (alive && selectedRef.current === want) {
          setS(j);
          setErr(null);
        }
      } catch (e) {
        if (alive) setErr((e as Error).message);
      }
    };
    load();
    loadNow.current = load;
    const a = setInterval(load, 4000);
    const b = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      clearInterval(a);
      clearInterval(b);
    };
  }, []);

  const loadNow = useRef<() => void>(() => {});
  useEffect(() => {
    selectedRef.current = selected;
    loadNow.current();
  }, [selected]);

  const start = async (kind: 'seven_day' | 'continuous' = 'seven_day') => {
    const msg =
      kind === 'continuous'
        ? 'Start a separate CONTINUOUS paper-trading experiment with its own 10,000 simulated ISK?\n\nNo end date and no daily loss halt; it stops itself permanently at a 20% drawdown from peak equity. The seven-day experiment is not affected.'
        : 'Start the seven-day paper-trading experiment with 10,000 simulated ISK?';
    if (starting || !confirm(msg)) return;
    setStarting(true);
    try {
      const url = `/api/experiment/start?kind=${kind}`;
      let r = await fetch(url, { method: 'POST' });
      if (r.status === 401) {
        const token = prompt('Admin token for this deployment:');
        if (!token) return;
        r = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      }
      const j = await r.json();
      if (!r.ok) alert(j.error);
      else choose(j.id);
    } finally {
      setStarting(false);
    }
  };

  const e = s?.experiment ?? null;
  const engineAlive = !!s && now - s.bot.lastTickAt < s.bot.pollSeconds * 3000;
  const status = !s
    ? { label: err ? 'Engine unreachable' : 'Connecting', tone: err ? ('rose' as const) : ('sky' as const) }
    : engineAlive
      ? (STATUS[s.bot.status] ?? { label: s.bot.status, tone: 'sky' as const })
      : { label: 'Engine not responding', tone: 'rose' as const };
  const continuous = e?.kind === 'continuous';
  const countdown = e
    ? e.status === 'halted'
      ? { label: 'Halted', detail: '20% drawdown safety halt', progress: null, msLeft: 0 }
      : e.status === 'finished'
        ? { label: 'Complete', detail: 'Seven days finished', progress: 1, msLeft: 0 }
        : e.endsAt == null
          ? { label: `Running ${duration(now - e.startedAt)}`, detail: `Continuous · day ${Math.floor((now - e.startedAt) / 86_400_000) + 1}`, progress: null, msLeft: now - e.startedAt }
          : {
              label: `${duration(e.endsAt - now)} left`,
              detail: `Day ${Math.min(7, Math.floor((now - e.startedAt) / 86_400_000) + 1)} of 7`,
              progress: Math.min(1, (now - e.startedAt) / (e.endsAt - e.startedAt)),
              msLeft: e.endsAt - now,
            }
    : null;

  let kpis: Stat[] = [];
  let summary: Stat[] = [];
  if (s && e) {
    const totalPct = (e.totalPnlIsk / e.initialIsk) * 100;
    const dayStart = e.equityIsk - e.dailyPnlIsk;
    const vsSol = ((e.equityIsk - e.solHoldIsk) / e.initialIsk) * 100;
    const solRet = (e.solHoldIsk / e.initialIsk - 1) * 100;
    const costs = e.costs.feesIsk + e.costs.slippageIsk;
    const todayPct = dayStart ? (e.dailyPnlIsk / dayStart) * 100 : 0;
    kpis = [
      { label: 'Portfolio value', value: isk(e.equityIsk), n: e.equityIsk, delta: totalPct, footnote: 'since start' },
      { label: 'Net P/L', value: isk(e.totalPnlIsk, true), n: e.totalPnlIsk, valueCls: pnlCls(e.totalPnlIsk), footnote: 'after all simulated costs' },
      { label: 'Win rate', value: e.stats.completed ? pct(e.stats.winRate * 100, 0, false) : '—', n: e.stats.winRate, footnote: `${e.stats.completed} completed · ${e.stats.wins}W / ${e.stats.losses}L` },
      { label: 'Trading costs', value: isk(costs), n: costs, footnote: `fees ${Math.round(e.costs.feesIsk)} · slippage ${Math.round(e.costs.slippageIsk)}` },
    ];
    summary = [
      {
        label: 'Today net P/L',
        value: isk(e.dailyPnlIsk, true),
        n: e.dailyPnlIsk,
        valueCls: pnlCls(e.dailyPnlIsk),
        footnote: `${pct(todayPct)} · ${s.config.dailyLossLimitIsk != null ? `limit −${s.config.dailyLossLimitIsk} ISK` : 'no daily halt'}`,
      },
      { label: 'vs. holding SOL', value: pct(vsSol), n: vsSol, valueCls: pnlCls(vsSol), footnote: `SOL hold return ${pct(solRet)}` },
      {
        label: 'Max drawdown',
        value: pct(-e.drawdown.pct * 100),
        n: -e.drawdown.pct,
        footnote:
          s.config.maxDrawdownPct != null
            ? `now ${e.currentDrawdownPct.toFixed(1)}% · halt at ${Math.round(s.config.maxDrawdownPct * 100)}%`
            : `${isk(e.drawdown.isk)} from peak`,
      },
      { label: 'Cash available', value: isk(e.cashIsk), n: e.cashIsk, footnote: `${isk(e.positionsIsk)} in positions` },
      { label: 'Open positions', value: `${e.openPositions.length} / ${s.config.maxOpenPositions}`, n: e.openPositions.length, footnote: `up to ${isk(s.config.maxPositionIsk)} each` },
      { label: 'Failed transactions', value: `${e.costs.failed}`, n: e.costs.failed, footnote: `of ${e.costs.failed + e.costs.filled} simulated` },
    ];
  }
  // Literal class names so Tailwind can see them.
  const STAGGER = ['[--i:0]', '[--i:1]', '[--i:2]', '[--i:3]', '[--i:4]', '[--i:5]', '[--i:6]'];
  const reveal = (i: number) => cn('v-reveal', STAGGER[Math.min(i, 6)]);

  return (
    <TraderShell
      canStart={!!s?.data.healthy && !starting}
      countdown={countdown}
      dataLive={!!s?.data.healthy}
      experimentId={e?.id ?? null}
      hasReport={!!e?.hasFinalReport}
      loading={!s}
      onStart={() => start('seven_day')}
      reportHref={e ? `/api/report?experiment=${e.id}` : '/api/report'}
      pathname={hash}
      solUsd={s?.data.solUsd ?? null}
      status={status}
    >
      <div className={`t-skel t-skel--flow flex flex-col ${s ? 'is-revealed' : ''}`}>
        {!skeletonGone && <PageSkeleton message={!s && err ? `Cannot reach the trading engine (${err}). Retrying…` : null} />}
        <div className="t-skel-content flex flex-col gap-6 md:gap-8">
          {s && (
            <>
              {s.experiments.length > 0 && (
                <ExperimentSwitcher
                  canStart={s.data.healthy && !starting}
                  current={e?.id ?? selected}
                  experiments={s.experiments}
                  onSelect={choose}
                  onStartContinuous={() => start('continuous')}
                />
              )}
              <section aria-label="Experiment summary" className={cn('relative isolate shrink-0 overflow-hidden rounded-2xl bg-card', reveal(0))} id="overview">
                <img alt="" className="absolute inset-0 -z-10 size-full object-cover object-[center_68%] opacity-50" decoding="async" src="/banner.webp" />
                <div className="absolute inset-0 -z-10 bg-gradient-to-r from-card via-card/75 to-card/10" />
                <div className="absolute inset-0 -z-10 bg-gradient-to-t from-card/90 via-card/20 to-transparent" />
                <div className="flex min-h-44 flex-col justify-end gap-5 p-6 sm:min-h-56 sm:flex-row sm:items-end sm:justify-between sm:p-8">
                  <TextsReveal
                    className="min-w-0"
                    lines={[
                      <p className="text-xs text-muted-foreground">
                        <span className="text-amber-300">Paper trading</span>
                        {e ? ` · Experiment #${e.id}${countdown ? ` · ${countdown.detail}` : ''}` : ' · No experiment running'}
                      </p>,
                      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-balance sm:text-[32px]">{continuous ? 'Continuous experiment' : 'Overview'}</h1>,
                      <p className="mt-1.5 max-w-md text-sm text-pretty text-muted-foreground">
                        {continuous
                          ? 'Open-ended forward test with its own 10,000 simulated ISK. No daily loss halt; stops permanently at a 20% drawdown. No real funds or wallets.'
                          : 'Seven-day forward test of a Solana memecoin strategy with 10,000 simulated ISK. No real funds or wallets.'}
                      </p>,
                    ]}
                  />
                  <div className="flex shrink-0 flex-col gap-1.5 text-xs sm:items-end">
                    {countdown && (
                      <p className="num text-sm font-medium">
                        <SubtleNumber text={countdown.label} value={countdown.msLeft} />
                      </p>
                    )}
                    {engineAlive && s.bot.detail && (
                      <p className="max-w-72 truncate sm:text-right">
                        {s.bot.status === 'RUNNING' ? <Shimmer text={s.bot.detail} /> : <span className="text-amber-300">{s.bot.detail}</span>}
                      </p>
                    )}
                  </div>
                </div>
              </section>
              {err && (
                <div className="rounded-xl bg-down/10 px-4 py-3 text-sm text-down">Lost connection to engine: {err}. Showing last known state.</div>
              )}
              {engineAlive && s.bot.status !== 'RUNNING' && s.bot.status !== 'IDLE_NO_EXPERIMENT' && (
                <div className="rounded-xl bg-amber-400/10 px-4 py-3 text-sm text-amber-300">
                  {status.label}: {s.bot.detail}
                </div>
              )}

              {e ? (
                <>
                  <div className={reveal(1)}>
                    <KpiStrip stats={kpis} />
                  </div>
                  <div className="grid grid-cols-1 gap-6 md:gap-8 lg:grid-cols-12">
                    <EquityCard className={cn('lg:col-span-8', reveal(2))} e={e} />
                    <SummaryCard className={cn('lg:col-span-4', reveal(3))} rows={summary} />
                    <PositionsCard cfg={s.config} className={cn('lg:col-span-8', reveal(4))} e={e} now={now} onOpenChart={setChartId} />
                    <RiskCard cfg={s.config} className={cn('lg:col-span-4', reveal(5))} e={e} />
                    <TransactionsCard className={cn('lg:col-span-12', reveal(6))} trades={e.trades} />
                    <CompletedCard className="lg:col-span-12" e={e} onOpenChart={setChartId} />
                    <ActivityCard className="lg:col-span-6" now={now} s={s} />
                    <FeedsCard className="lg:col-span-6" now={now} s={s} />
                    <TokensCard className="lg:col-span-12" min={s.config.minEntryScore} tokens={s.tokens} />
                  </div>
                </>
              ) : (
                <div className="grid grid-cols-1 gap-6 md:gap-8 lg:grid-cols-12">
                  <Card className={cn(cardCls, 'lg:col-span-12', reveal(1))}>
                    <CardHeader>
                      <CardTitle className="text-[15px] font-medium">No experiment running</CardTitle>
                      <CardDescription>
                        The engine is already watching tokens. Starting allocates exactly 10,000 simulated ISK and begins a seven-day forward paper-trading window.
                        Keep the engine running for the whole period.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <Button disabled={!s.data.healthy || starting} onClick={() => start('seven_day')}>
                        {starting ? 'Starting…' : s.data.healthy ? 'Start 7-day experiment' : 'Waiting for live data…'}
                      </Button>
                    </CardContent>
                  </Card>
                  <FeedsCard className={cn('lg:col-span-6', reveal(2))} now={now} s={s} />
                  <ActivityCard className={cn('lg:col-span-6', reveal(3))} now={now} s={s} />
                  <TokensCard className={cn('lg:col-span-12', reveal(4))} min={s.config.minEntryScore} tokens={s.tokens} />
                </div>
              )}

              <p className="rounded-2xl bg-card px-6 py-4 text-xs leading-relaxed text-muted-foreground">
                <span className="font-medium text-amber-300">Simulated results only. </span>
                {s.disclaimer}
              </p>
            </>
          )}
        </div>
      </div>
      <ToastStack items={toasts.items} onDone={toasts.dismiss} />
      <TradeDetailSheet
        live={(() => {
          const op = e?.openPositions.find((x) => x.id === chartId);
          return op
            ? { markSol: op.markSol ?? null, markFresh: !!op.markFresh, unrealizedIsk: op.unrealizedIsk ?? null, changePct: op.changePct ?? null, solUsd: s?.data.solUsd ?? null }
            : null;
        })()}
        now={now}
        onClose={() => setChartId(null)}
        positionId={chartId}
      />
    </TraderShell>
  );
}

const KIND_LABEL = { seven_day: 'Seven-day', continuous: 'Continuous' } as const;

/** Tabs for the separate experiments. Each one has its own cash, positions and history. */
function ExperimentSwitcher({
  experiments,
  current,
  onSelect,
  onStartContinuous,
  canStart,
}: {
  experiments: ExperimentSummary[];
  current: number | null;
  onSelect: (id: number) => void;
  onStartContinuous: () => void;
  canStart: boolean;
}) {
  const showStart = !experiments.some((x) => x.kind === 'continuous' && x.status === 'running');
  return (
    <nav aria-label="Experiments" className="-mb-2 flex flex-wrap items-center gap-2">
      {experiments.map((x) => {
        const active = x.id === current;
        const st = x.status === 'running' ? (STATUS[x.botStatus]?.label ?? x.botStatus) : x.status === 'halted' ? 'Halted' : 'Finished';
        const dot = x.status !== 'running' ? 'bg-muted-foreground' : x.botStatus === 'RUNNING' ? 'bg-emerald-500' : x.botStatus.startsWith('HALTED') ? 'bg-rose-500' : 'bg-amber-400';
        return (
          <button
            aria-current={active ? 'page' : undefined}
            className={cn(
              'v-hover flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs transition-colors',
              active ? 'bg-card text-foreground ring-1 ring-border' : 'text-muted-foreground hover:bg-card/60 hover:text-foreground',
            )}
            key={x.id}
            onClick={() => onSelect(x.id)}
            type="button"
          >
            <span aria-hidden className={cn('size-1.5 rounded-full', dot)} />
            <span className="font-medium">
              {KIND_LABEL[x.kind]} #{x.id}
            </span>
            <span className="hidden text-muted-foreground sm:inline">· {st.split(' · ')[0]}</span>
          </button>
        );
      })}
      {showStart && (
        <button
          className="rounded-full px-3.5 py-1.5 text-xs text-primary transition-colors hover:bg-card/60 disabled:opacity-50"
          disabled={!canStart}
          onClick={onStartContinuous}
          type="button"
        >
          + Start continuous experiment
        </button>
      )}
    </nav>
  );
}

/** Placeholder shaped like the overview: banner, KPI strip, chart and summary. */
function PageSkeleton({ message }: { message: string | null }) {
  const block = 'rounded-2xl bg-card';
  const bar = 'rounded bg-surface-2';
  return (
    <div aria-hidden={!message} className="t-skel-skeleton is-pulsing flex flex-col gap-6 md:gap-8">
      <div className={`${block} flex min-h-44 items-end p-6 sm:min-h-56 sm:p-8`}>
        <div className="flex flex-col gap-3">
          <div className={`${bar} h-3 w-48`} />
          <div className={`${bar} h-7 w-40`} />
          <div className={`${bar} h-3 w-72 max-w-full`} />
        </div>
      </div>
      {message && <p className="text-sm text-down">{message}</p>}
      <div className={`${block} grid grid-cols-2 lg:grid-cols-4`}>
        {Array.from({ length: 4 }, (_, i) => (
          <div className="flex h-[124px] flex-col justify-between px-6 py-6" key={i}>
            <div className={`${bar} h-3 w-24`} />
            <div className={`${bar} h-7 w-32`} />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-6 md:gap-8 lg:grid-cols-12">
        <div className={`${block} h-[380px] sm:h-[460px] lg:col-span-8 lg:h-[500px]`} />
        <div className={`${block} hidden h-[500px] lg:col-span-4 lg:block`} />
      </div>
    </div>
  );
}

/** Toast (transitions.dev 22) for each simulated execution that lands while the page is open. */
function useTradeToasts(s: State | null) {
  const seen = useRef<number | null>(null);
  const expRef = useRef<number | null>(null);
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    const trades = s?.experiment?.trades;
    if (!trades) return;
    const maxId = trades.reduce((m, t) => Math.max(m, t.id), 0);
    // Switching experiments shows another history: never toast it.
    if (expRef.current !== s!.experiment!.id) {
      expRef.current = s!.experiment!.id;
      seen.current = maxId;
      return;
    }
    if (seen.current == null) {
      seen.current = maxId; // existing history never toasts
      return;
    }
    const fresh = trades.filter((t) => t.id > seen.current!).sort((a, b) => a.id - b.id);
    if (!fresh.length) return;
    seen.current = maxId;
    setItems((cur) =>
      [
        ...cur,
        ...fresh.map((t): ToastItem => {
          const failed = t.status === 'FAILED';
          return {
            id: t.id,
            tone: failed ? 'failed' : t.side === 'BUY' ? 'buy' : 'sell',
            title: failed ? `${t.side} ${t.symbol} failed (simulated)` : `${t.side === 'BUY' ? 'Bought' : 'Sold'} ${t.symbol} · ${isk(Math.abs(t.iskAmount))}`,
            body: failed ? (t.failReason ?? '') : t.reason,
          };
        }),
      ].slice(-3),
    );
  }, [s]);
  const dismiss = useCallback((id: number) => setItems((cur) => cur.filter((t) => t.id !== id)), []);
  return { items, dismiss };
}

function pnlCls(n: number) {
  return n > 0 ? 'text-up' : n < 0 ? 'text-down' : '';
}
