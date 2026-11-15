import { useEffect, useState } from 'react';
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

const STATUS: Record<string, { label: string; tone: StatusTone }> = {
  RUNNING: { label: 'Running', tone: 'emerald' },
  PAUSED_STALE_DATA: { label: 'Paused · stale data', tone: 'amber' },
  HALTED_DAILY_LOSS: { label: 'Halted · daily loss limit', tone: 'rose' },
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
      const r = await fetch('/api/experiment/start', { method: 'POST' });
      const j = await r.json();
      if (!r.ok) alert(j.error);
    } finally {
      setStarting(false);
    }
  };

  if (!s) {
    return (
      <div className="flex min-h-svh items-center justify-center text-sm text-muted-foreground">
        {err ? `Cannot reach the trading engine (${err}). Is \`npm start\` running?` : 'Connecting to engine…'}
      </div>
    );
  }

  const e = s.experiment;
  const engineAlive = now - s.bot.lastTickAt < s.bot.pollSeconds * 3000;
  const status = engineAlive ? (STATUS[s.bot.status] ?? { label: s.bot.status, tone: 'sky' as const }) : { label: 'Engine not responding', tone: 'rose' as const };
  const countdown = e
    ? e.status === 'finished'
      ? { label: 'Complete', detail: 'Seven days finished', progress: 1 }
      : {
          label: `${duration(e.endsAt - now)} left`,
          detail: `Day ${Math.min(7, Math.floor((now - e.startedAt) / 86_400_000) + 1)} of 7`,
          progress: Math.min(1, (now - e.startedAt) / (e.endsAt - e.startedAt)),
        }
    : null;

  let stats: Stat[] = [];
  if (e) {
    const totalPct = (e.totalPnlIsk / e.initialIsk) * 100;
    const dayStart = e.equityIsk - e.dailyPnlIsk;
    const vsSol = ((e.equityIsk - e.solHoldIsk) / e.initialIsk) * 100;
    stats = [
      { label: 'Portfolio value', value: isk(e.equityIsk), delta: totalPct, footnote: 'since start' },
      { label: 'Total net P/L', value: isk(e.totalPnlIsk, true), valueCls: pnlCls(e.totalPnlIsk), footnote: 'after all simulated costs' },
      { label: 'Today net P/L', value: isk(e.dailyPnlIsk, true), valueCls: pnlCls(e.dailyPnlIsk), delta: dayStart ? (e.dailyPnlIsk / dayStart) * 100 : 0, footnote: `limit −${s.config.dailyLossLimitIsk} ISK` },
      { label: 'vs. holding SOL', value: pct(vsSol), valueCls: pnlCls(vsSol), delta: (e.solHoldIsk / e.initialIsk - 1) * 100, footnote: 'SOL hold return' },
      { label: 'Win rate', value: e.stats.completed ? pct(e.stats.winRate * 100, 0, false) : '—', footnote: `${e.stats.completed} completed · ${e.stats.wins}W / ${e.stats.losses}L` },
      { label: 'Max drawdown', value: pct(-e.drawdown.pct * 100), footnote: `${isk(e.drawdown.isk)} from peak` },
      { label: 'Trading costs', value: isk(e.costs.feesIsk + e.costs.slippageIsk), footnote: `fees ${Math.round(e.costs.feesIsk)} · slippage ${Math.round(e.costs.slippageIsk)}` },
      { label: 'Cash available', value: isk(e.cashIsk), footnote: `${isk(e.positionsIsk)} in positions` },
    ];
  }

  return (
    <TraderShell
      canStart={s.data.healthy && !starting}
      countdown={countdown}
      dataLive={s.data.healthy}
      experimentId={e?.id ?? null}
      hasReport={!!e?.hasFinalReport}
      onStart={start}
      pathname={hash}
      solUsd={s.data.solUsd}
      status={status}
    >
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
                The engine is already watching tokens. Starting allocates exactly 10,000 simulated ISK and begins a seven-day forward paper-trading window. Keep
                the engine running for the whole period.
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
    </TraderShell>
  );
}

function pnlCls(n: number) {
  return n > 0 ? 'text-emerald-500' : n < 0 ? 'text-rose-500' : '';
}
