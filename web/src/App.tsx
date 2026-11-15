import { useCallback, useEffect, useRef, useState } from 'react';
import type { State } from './types';
import { duration, isk, pct } from './format';
import { TraderShell, type StatusTone } from './trader/shell';
import {
  ActivityCard,
  CompletedCard,
  EquityCard,
  FeedsCard,
  PositionsCard,
  RiskCard,
  StatCard,
  TokensCard,
  TransactionsCard,
  type Stat,
} from './trader/cards';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Shimmer, SubtleNumber, TextsReveal, ToastStack, type ToastItem } from './trader/motion';

const STATUS: Record<string, { label: string; tone: StatusTone }> = {
  RUNNING: { label: 'Running', tone: 'emerald' },
  PAUSED_STALE_DATA: { label: 'Paused · stale data', tone: 'amber' },
  HALTED_DAILY_LOSS: { label: 'Halted · daily loss limit', tone: 'rose' },
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
        const r = await fetch('/api/state', { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as State;
        if (alive) {
          setS(j);
          setErr(null);
        }
      } catch (e) {
        if (alive) setErr((e as Error).message);
      }
    };
    load();
    const a = setInterval(load, 4000);
    const b = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      clearInterval(a);
      clearInterval(b);
    };
  }, []);

  const start = async () => {
    if (starting || !confirm('Start the seven-day paper-trading experiment with 10,000 simulated ISK?')) return;
    setStarting(true);
    try {
      let r = await fetch('/api/experiment/start', { method: 'POST' });
      if (r.status === 401) {
        const token = prompt('Admin token for this deployment:');
        if (!token) return;
        r = await fetch('/api/experiment/start', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      }
      const j = await r.json();
      if (!r.ok) alert(j.error);
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
  const countdown = e
    ? e.status === 'finished'
      ? { label: 'Complete', detail: 'Seven days finished', progress: 1, msLeft: 0 }
      : {
          label: `${duration(e.endsAt - now)} left`,
          detail: `Day ${Math.min(7, Math.floor((now - e.startedAt) / 86_400_000) + 1)} of 7`,
          progress: Math.min(1, (now - e.startedAt) / (e.endsAt - e.startedAt)),
          msLeft: e.endsAt - now,
        }
    : null;

  let stats: Stat[] = [];
  if (s && e) {
    const totalPct = (e.totalPnlIsk / e.initialIsk) * 100;
    const dayStart = e.equityIsk - e.dailyPnlIsk;
    const vsSol = ((e.equityIsk - e.solHoldIsk) / e.initialIsk) * 100;
    const costs = e.costs.feesIsk + e.costs.slippageIsk;
    stats = [
      { label: 'Portfolio value', value: isk(e.equityIsk), n: e.equityIsk, delta: totalPct, footnote: 'since start' },
      { label: 'Total net P/L', value: isk(e.totalPnlIsk, true), n: e.totalPnlIsk, valueCls: pnlCls(e.totalPnlIsk), footnote: 'after all simulated costs' },
      { label: 'Today net P/L', value: isk(e.dailyPnlIsk, true), n: e.dailyPnlIsk, valueCls: pnlCls(e.dailyPnlIsk), delta: dayStart ? (e.dailyPnlIsk / dayStart) * 100 : 0, footnote: `limit −${s.config.dailyLossLimitIsk} ISK` },
      { label: 'vs. holding SOL', value: pct(vsSol), n: vsSol, valueCls: pnlCls(vsSol), delta: (e.solHoldIsk / e.initialIsk - 1) * 100, footnote: 'SOL hold return' },
      { label: 'Win rate', value: e.stats.completed ? pct(e.stats.winRate * 100, 0, false) : '—', n: e.stats.winRate, footnote: `${e.stats.completed} completed · ${e.stats.wins}W / ${e.stats.losses}L` },
      { label: 'Max drawdown', value: pct(-e.drawdown.pct * 100), n: -e.drawdown.pct, footnote: `${isk(e.drawdown.isk)} from peak` },
      { label: 'Trading costs', value: isk(costs), n: costs, footnote: `fees ${Math.round(e.costs.feesIsk)} · slippage ${Math.round(e.costs.slippageIsk)}` },
      { label: 'Cash available', value: isk(e.cashIsk), n: e.cashIsk, footnote: `${isk(e.positionsIsk)} in positions` },
    ];
  }
  const totalPct = e ? (e.totalPnlIsk / e.initialIsk) * 100 : 0;

  return (
    <TraderShell
      canStart={!!s?.data.healthy && !starting}
      countdown={countdown}
      dataLive={!!s?.data.healthy}
      experimentId={e?.id ?? null}
      hasReport={!!e?.hasFinalReport}
      loading={!s}
      onStart={start}
      pathname={hash}
      solUsd={s?.data.solUsd ?? null}
      status={status}
    >
      <div className={`t-skel t-skel--flow flex flex-col gap-4 ${s ? 'is-revealed' : ''}`}>
        {!skeletonGone && <PageSkeleton message={!s && err ? `Cannot reach the trading engine (${err}). Retrying…` : null} />}
        <div className="t-skel-content flex flex-col gap-4">
          {s && (
            <>
              <section aria-label="Experiment summary" className="relative isolate shrink-0 overflow-hidden rounded-xl border bg-black">
                <img alt="" className="absolute inset-0 -z-10 size-full object-cover object-[center_70%]" decoding="async" src="/banner.webp" />
                <div className="absolute inset-0 -z-10 bg-gradient-to-r from-black/85 via-black/45 to-black/0" />
                <div className="absolute inset-x-0 bottom-0 -z-10 h-1/2 bg-gradient-to-t from-black/50 to-transparent" />
                <div className="flex min-h-40 flex-col justify-end gap-4 p-5 sm:min-h-52 sm:flex-row sm:items-end sm:justify-between sm:p-7">
                  <TextsReveal
                    className="min-w-0"
                    lines={[
                      <p className="text-[11px] font-medium tracking-[0.12em] text-white/55 uppercase">Simulated · paper trading only</p>,
                      <h1 className="mt-1 text-xl font-semibold tracking-tight text-balance text-white sm:text-2xl">Solana Paper Trader</h1>,
                      e ? (
                        <p className="num mt-2 flex flex-wrap items-baseline gap-x-2 text-sm text-white/75">
                          <SubtleNumber className="text-2xl font-semibold tracking-tight text-white sm:text-3xl" text={isk(e.equityIsk)} value={e.equityIsk} />
                          <SubtleNumber className={totalPct >= 0 ? 'text-emerald-400' : 'text-rose-400'} text={pct(totalPct)} value={totalPct} />
                        </p>
                      ) : (
                        <p className="mt-2 text-sm text-white/70">Seven-day forward test with 10,000 simulated ISK</p>
                      ),
                    ]}
                  />
                  <div className="flex shrink-0 flex-col gap-1 text-xs sm:items-end">
                    {countdown && (
                      <p className="num text-white/75">
                        {countdown.detail} · <SubtleNumber text={countdown.label} value={countdown.msLeft} />
                      </p>
                    )}
                    {engineAlive && s.bot.detail && (
                      <p className="max-w-72 truncate sm:text-right">
                        {s.bot.status === 'RUNNING' ? (
                          <Shimmer className="t-shimmer--on-photo" text={s.bot.detail} />
                        ) : (
                          <span className="text-amber-300">{s.bot.detail}</span>
                        )}
                      </p>
                    )}
                  </div>
                </div>
              </section>
              {err && (
                <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-sm text-rose-500">
                  Lost connection to engine: {err}. Showing last known state.
                </div>
              )}
              {engineAlive && s.bot.status !== 'RUNNING' && s.bot.status !== 'IDLE_NO_EXPERIMENT' && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-500">
                  {status.label}: {s.bot.detail}
                </div>
              )}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4" id="overview">
                {!e && (
                  <Card className="shadow-none sm:col-span-2 lg:col-span-4 dark:ring-0">
                    <CardHeader>
                      <CardTitle>No experiment running</CardTitle>
                      <CardDescription>
                        The engine is already watching tokens. Starting allocates exactly 10,000 simulated ISK and begins a seven-day forward paper-trading window.
                        Keep the engine running for the whole period.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <Button disabled={!s.data.healthy || starting} onClick={start}>
                        {starting ? 'Starting…' : s.data.healthy ? 'Start 7-day experiment' : 'Waiting for live data…'}
                      </Button>
                    </CardContent>
                  </Card>
                )}

                {e && (
                  <>
                    {stats.map((st) => (
                      <StatCard key={st.label} s={st} />
                    ))}
                    <EquityCard e={e} />
                    <RiskCard cfg={s.config} e={e} />
                    <PositionsCard cfg={s.config} e={e} now={now} />
                  </>
                )}
                <FeedsCard className={e ? '' : 'sm:col-span-1 lg:col-span-2'} now={now} s={s} />
                <ActivityCard className={e ? '' : 'sm:col-span-1 lg:col-span-2'} now={now} s={s} />
                {e && <TransactionsCard trades={e.trades} />}
                {e && <CompletedCard e={e} />}
                <TokensCard min={s.config.minEntryScore} tokens={s.tokens} />
              </div>

              <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs leading-relaxed text-amber-500">{s.disclaimer}</p>
            </>
          )}
        </div>
      </div>
      <ToastStack items={toasts.items} onDone={toasts.dismiss} />
    </TraderShell>
  );
}

/** Placeholder shaped like the overview: banner, eight stat cards, chart and risk card. */
function PageSkeleton({ message }: { message: string | null }) {
  const block = 'rounded-xl border bg-muted/40';
  return (
    <div aria-hidden={!message} className="t-skel-skeleton is-pulsing flex flex-col gap-4">
      <div className={`${block} flex min-h-40 items-end p-5 sm:min-h-52 sm:p-7`}>
        <div className="flex flex-col gap-2">
          <div className="h-3 w-40 rounded bg-muted" />
          <div className="h-6 w-56 rounded bg-muted" />
          <div className="h-7 w-36 rounded bg-muted" />
        </div>
      </div>
      {message && <p className="text-sm text-rose-400">{message}</p>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <div className={`${block} flex h-[134px] flex-col justify-between p-6`} key={i}>
            <div className="h-3 w-24 rounded bg-muted" />
            <div className="h-7 w-32 rounded bg-muted" />
          </div>
        ))}
        <div className={`${block} h-80 sm:col-span-2 lg:col-span-3`} />
        <div className={`${block} hidden h-80 lg:block`} />
      </div>
    </div>
  );
}

/** Toast (transitions.dev 22) for each simulated execution that lands while the page is open. */
function useTradeToasts(s: State | null) {
  const seen = useRef<number | null>(null);
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    const trades = s?.experiment?.trades;
    if (!trades) return;
    const maxId = trades.reduce((m, t) => Math.max(m, t.id), 0);
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
  return n > 0 ? 'text-emerald-500' : n < 0 ? 'text-rose-500' : '';
}
