// Trade detail panel: real GeckoTerminal candles for the exact pool the engine
// traded, with the engine's simulated fills drawn on top. Read-only: nothing in
// here can place, change or close a trade.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { CheckIcon, CopyIcon, ExternalLinkIcon, RefreshCwIcon } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { dateTime, duration, isk, pct, price, tone, usd } from '../format';
import { SlidingTabs, SubtleNumber } from './motion';

const TFS = ['1m', '5m', '15m', '1h', '4h', '1D'] as const;
type Tf = (typeof TFS)[number];
const TF_SEC: Record<Tf, number> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14_400, '1D': 86_400 };

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
interface ChartTrade {
  id: number; ts: number; side: 'BUY' | 'SELL'; status: string; markPriceSol: number; quotedPriceSol: number; fillPriceSol: number | null;
  solAmount: number; tokenAmount: number; iskAmount: number; feeIsk: number; slippageIsk: number; reason: string; failReason: string | null; solUsd: number | null;
}
interface ChartPayload {
  position: {
    id: number; symbol: string; name: string; tokenAddress: string; pairAddress: string; status: string; openedAt: number; closedAt: number | null;
    tokenAmount: number; costIsk: number; entryPriceSol: number; entryMarkSol: number; lastMarkSol: number; exitReason: string | null;
    netPnlIsk: number | null; proceedsIsk: number | null; slPriceSol: number; tpPriceSol: number; entrySolUsd: number | null;
  };
  trades: ChartTrade[];
  pool: null | {
    name: string; dex: string | null; quoteIsSol: boolean; priceUsd: number | null; priceQuote: number | null;
    liquidityUsd: number | null; volume24hUsd: number | null; marketCapUsd: number | null; fdvUsd: number | null;
  };
  chart: {
    timeframe: Tf; unit: 'SOL' | 'USD'; volumeUnit: string; source: string; truncated: boolean; candles: Candle[];
    error: null | { message: string; status: number; retryAfter?: number };
  };
}

/** What the dashboard already knows live about the position (from /api/state). */
export interface LiveMark { markSol: number | null; markFresh: boolean; unrealizedIsk: number | null; changePct: number | null; solUsd: number | null }

// lightweight-charts draws UTC; shift so the axis reads in the viewer's local time.
const local = (sec: number) => (sec - new Date(sec * 1000).getTimezoneOffset() * 60) as UTCTimestamp;
const css = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

function useChartData(id: number | null, tf: Tf | null, live: boolean) {
  const [data, setData] = useState<ChartPayload | null>(null);
  const [error, setError] = useState<{ message: string; retryAfter?: number | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (id == null) return;
    const ctrl = new AbortController();
    let timer: number | undefined;
    const load = async (quiet: boolean) => {
      if (!quiet) setLoading(true);
      try {
        const r = await fetch(`/api/positions/${id}/chart${tf ? `?tf=${tf}` : ''}`, { signal: ctrl.signal, cache: 'no-store' });
        const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
        if (!r.ok) throw Object.assign(new Error(j.error ?? `HTTP ${r.status}`), { retryAfter: j.retryAfter });
        setData(j as ChartPayload);
        setError(null);
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        if (!quiet) setError({ message: (e as Error).message, retryAfter: (e as { retryAfter?: number }).retryAfter });
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
      // Open positions refresh once a minute; the server caches and rate-limits upstream calls.
      if (live && !ctrl.signal.aborted) timer = window.setTimeout(() => load(true), 60_000);
    };
    load(false);
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [id, tf, live, nonce]);

  useEffect(() => {
    setData(null);
    setError(null);
  }, [id]);
  return { data, error, loading, reload };
}

// ---------- Chart ----------

interface Level { price: number; label: string; color: string; style: LineStyle }

// Zoom/pan survives the once-a-minute refresh of an open position.
const savedRanges = new Map<string, { from: number; to: number }>();

function CandleChart({ candles, tf, levels, markers, unit, onReady, viewKey, focus }: {
  candles: Candle[]; tf: Tf; levels: Level[]; unit: 'SOL' | 'USD'; viewKey: string;
  /** Trade window in unix ms: the initial view frames entry to exit. */
  focus: { from: number; to: number };
  markers: { ts: number; side: 'BUY' | 'SELL'; price: number }[];
  onReady?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const legend = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const up = css('--up', '#00d49a');
    const down = css('--down', '#f0616d');
    const muted = css('--muted-foreground', '#8b9099');
    const fmt = (p: number) => (unit === 'USD' ? '$' : '') + price(p);
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: muted, fontFamily: 'Inter, ui-sans-serif, system-ui', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: 'rgba(255,255,255,0.035)' }, horzLines: { color: 'rgba(255,255,255,0.035)' } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.24 } },
      timeScale: { borderVisible: false, timeVisible: tf !== '1D', secondsVisible: false, rightOffset: 4 },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(255,255,255,0.18)', labelBackgroundColor: '#1c2026', style: LineStyle.Dashed },
        horzLine: { color: 'rgba(255,255,255,0.18)', labelBackgroundColor: '#1c2026', style: LineStyle.Dashed },
      },
      handleScroll: true,
      handleScale: true,
    });
    chartRef.current = chart;
    const lo = Math.min(...levels.map((l) => l.price));
    const hi = Math.max(...levels.map((l) => l.price));
    const series = chart.addSeries(CandlestickSeries, {
      upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down,
      priceFormat: { type: 'custom', formatter: fmt, minMove: 1e-12 },
      priceLineVisible: false,
      // Keep the stop-loss / take-profit / fill levels on screen.
      autoscaleInfoProvider: (orig: () => { priceRange: { minValue: number; maxValue: number } } | null) => {
        const r = orig();
        if (!r || !levels.length) return r;
        return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, lo), maxValue: Math.max(r.priceRange.maxValue, hi) } };
      },
    });
    const vol = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    series.setData(candles.map((c) => ({ time: local(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));
    vol.setData(candles.map((c) => ({ time: local(c.time), value: c.volume, color: c.close >= c.open ? 'rgba(0,212,154,0.32)' : 'rgba(240,97,109,0.32)' })));

    for (const l of levels) series.createPriceLine({ price: l.price, color: l.color, lineWidth: 1, lineStyle: l.style, axisLabelVisible: true, title: l.label });

    // Fill markers sit on the candle that contains the fill, at the exact simulated fill price.
    const sec = TF_SEC[tf];
    const times = candles.map((c) => c.time);
    const ms: SeriesMarker<Time>[] = [];
    for (const m of markers) {
      const t = Math.floor(m.ts / 1000);
      let idx = -1;
      for (let i = times.length - 1; i >= 0; i--) if (times[i] <= t) { idx = i; break; }
      if (idx < 0 || t - times[idx] >= sec) continue; // no candle for that interval: draw no marker
      ms.push({
        time: local(times[idx]), price: m.price, position: m.side === 'BUY' ? 'atPriceBottom' : 'atPriceTop',
        color: m.side === 'BUY' ? up : '#e8b04b', shape: m.side === 'BUY' ? 'arrowUp' : 'arrowDown', text: m.side, size: 1.2,
      } as SeriesMarker<Time>);
    }
    ms.sort((a, b) => (a.time as number) - (b.time as number));
    createSeriesMarkers(series, ms);
    // Frame the trade (with context) once layout has settled; stop as soon as the viewer zooms or pans.
    const saved = savedRanges.get(viewKey);
    let touched = false;
    const touch = () => (touched = true);
    el.addEventListener('pointerdown', touch);
    el.addEventListener('wheel', touch, { passive: true });
    el.addEventListener('touchstart', touch, { passive: true });
    const frame = () => {
      if (touched) return;
      if (saved) return chart.timeScale().setVisibleLogicalRange(saved);
      const sec = TF_SEC[tf];
      const pad = Math.max(12 * sec, (focus.to - focus.from) / 1000 * 0.25);
      const from = focus.from / 1000 - pad;
      const to = focus.to / 1000 + pad;
      // Frame by bar index: robust to gaps (minutes with no trades have no candle).
      let i0 = candles.findIndex((c) => c.time >= from);
      let i1 = candles.length - 1;
      while (i1 > 0 && candles[i1].time > to) i1--;
      if (i0 < 0) i0 = 0;
      if (i1 > i0) chart.timeScale().setVisibleLogicalRange({ from: i0 - 0.5, to: i1 + 2.5 });
      else chart.timeScale().fitContent();
    };
    // The panel slides in, so the first measured width is not final: re-frame on every
    // size change (and once the slide has finished) until the viewer takes over.
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (el.clientWidth > 0) frame();
      });
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    const settle = window.setTimeout(schedule, 500);

    const byTime = new Map(candles.map((c) => [local(c.time) as number, c]));
    const setLegend = (c: Candle | undefined) => {
      const el2 = legend.current;
      if (!el2) return;
      if (!c) { el2.textContent = ''; return; }
      const chg = (c.close / c.open - 1) * 100;
      const cls = chg >= 0 ? 'text-up' : 'text-down';
      el2.innerHTML =
        `<span>O <b>${fmt(c.open)}</b></span><span>H <b>${fmt(c.high)}</b></span><span>L <b>${fmt(c.low)}</b></span>` +
        `<span>C <b class="${cls}">${fmt(c.close)}</b></span><span class="${cls}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</span>` +
        `<span>Vol <b>${c.volume.toLocaleString('en-US', { maximumFractionDigits: unit === 'SOL' ? 2 : 0 })}</b></span>`;
    };
    setLegend(candles[candles.length - 1]);
    chart.subscribeCrosshairMove((p) => setLegend(p.time != null ? byTime.get(p.time as number) : candles[candles.length - 1]));
    onReady?.();
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(settle);
      ro.disconnect();
      el.removeEventListener('pointerdown', touch);
      el.removeEventListener('wheel', touch);
      el.removeEventListener('touchstart', touch);
      // Remember the view only when the viewer chose it (zoom/pan), so refreshes keep it.
      const r = touched ? chart.timeScale().getVisibleLogicalRange() : null;
      if (r) savedRanges.set(viewKey, { from: r.from, to: r.to });
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, tf, levels, markers, unit, onReady, viewKey, focus]);

  return (
    <div className="flex h-full w-full flex-col">
      <div
        aria-hidden="true"
        className="num pointer-events-none flex min-h-5 flex-wrap gap-x-3 gap-y-0.5 px-2 pb-1 text-[11px] text-muted-foreground [&_b]:font-medium [&_b]:text-foreground"
        ref={legend}
      />
      <div className="min-h-0 w-full flex-1" ref={host} />
    </div>
  );
}

// ---------- Panel ----------

function CopyAddress({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="group inline-flex max-w-full items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors duration-(--duration-fast) ease-(--ease-smooth-out) hover:text-foreground"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
      title="Copy contract address"
      type="button"
    >
      <span className="truncate">{value}</span>
      {done ? <CheckIcon className="size-3.5 shrink-0 text-up" /> : <CopyIcon className="size-3.5 shrink-0" />}
    </button>
  );
}

function Stat({ label, children, sub, cls }: { label: string; children: React.ReactNode; sub?: React.ReactNode; cls?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl bg-card px-4 py-3">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className={cn('num truncate text-sm font-medium', cls)}>{children}</span>
      {sub != null && <span className="num truncate text-[11px] text-muted-foreground">{sub}</span>}
    </div>
  );
}

export function TradeDetailSheet({ positionId, live, now, onClose }: { positionId: number | null; live: LiveMark | null; now: number; onClose: () => void }) {
  const [tf, setTf] = useState<Tf | null>(null);
  useEffect(() => setTf(null), [positionId]);
  const { data, error, loading, reload } = useChartData(positionId, tf, !!live);
  const [ready, setReady] = useState(false);
  const onReady = useCallback(() => requestAnimationFrame(() => setReady(true)), []);
  const shownTf = tf ?? data?.chart.timeframe ?? null;

  const p = data?.position;
  const unit = data?.chart.unit ?? 'SOL';
  // Prices arrive in SOL from the engine. On a non-SOL pool the chart is in USD, so convert
  // each fill with the SOL/USD rate recorded at that fill (exact), and SL/TP with the entry rate.
  const toUnit = useCallback((sol: number, solUsd: number | null | undefined) => (unit === 'SOL' ? sol : solUsd ? sol * solUsd : null), [unit]);
  const fills = useMemo(() => (data?.trades ?? []).filter((t) => t.status === 'FILLED' && t.fillPriceSol != null), [data]);
  const entry = fills.find((t) => t.side === 'BUY');
  const exit = [...fills].reverse().find((t) => t.side === 'SELL');

  const levels = useMemo<Level[]>(() => {
    if (!p) return [];
    const out: Level[] = [];
    const push = (v: number | null, label: string, color: string, style: LineStyle) => v != null && out.push({ price: v, label, color, style });
    push(toUnit(p.tpPriceSol, p.entrySolUsd), 'TP', '#00d49a', LineStyle.Dashed);
    push(toUnit(p.slPriceSol, p.entrySolUsd), 'SL', '#f0616d', LineStyle.Dashed);
    if (entry) push(toUnit(entry.fillPriceSol!, entry.solUsd), 'Entry fill', 'rgba(245,245,247,0.55)', LineStyle.Dotted);
    if (exit) push(toUnit(exit.fillPriceSol!, exit.solUsd), 'Exit fill', '#e8b04b', LineStyle.Dotted);
    return out;
  }, [p, entry, exit, toUnit]);
  const markers = useMemo(
    () => fills.flatMap((t) => {
      const v = toUnit(t.fillPriceSol!, t.solUsd);
      return v == null ? [] : [{ ts: t.ts, side: t.side, price: v }];
    }),
    [fills, toUnit],
  );
  // Never show candles under a timeframe they don't belong to while the new set loads.
  const tfMatches = !!data && (tf == null || data.chart.timeframe === tf);
  const candles = tfMatches ? data!.chart.candles : [];
  const focusFrom = p?.openedAt ?? 0;
  const focusTo = p?.closedAt ?? null;
  // Open trades frame entry → latest candle; the memo keeps the chart from rebuilding every second.
  const focus = useMemo(() => ({ from: focusFrom, to: focusTo ?? Date.now() }), [focusFrom, focusTo, data]);
  useEffect(() => setReady(false), [positionId, shownTf]);

  const open = p ? p.status === 'open' : !!live;
  const pnl = open ? live?.unrealizedIsk ?? null : p?.netPnlIsk ?? null;
  const markSol = open ? live?.markSol ?? p?.lastMarkSol ?? null : null;
  const fmtPx = (sol: number | null | undefined) => (sol == null ? '—' : `${price(sol)} SOL`);
  const durationMs = p ? (p.closedAt ?? now) - p.openedAt : 0;
  const chartErr = error?.message ?? (tfMatches ? data?.chart.error?.message : null) ?? null;
  const retryAfter = error?.retryAfter ?? data?.chart.error?.retryAfter ?? null;

  return (
    <Sheet onOpenChange={(o) => !o && onClose()} open={positionId != null}>
      <SheetContent className="w-full gap-0 overflow-y-auto border-l-0 bg-background p-0 sm:max-w-[min(980px,94vw)]">
        <SheetHeader className="gap-3 px-5 pt-6 pb-4 sm:px-8 sm:pt-8">
          <div className="flex flex-wrap items-center gap-2 pr-8">
            <SheetTitle className="text-xl font-semibold tracking-tight">{p?.symbol ?? '…'}</SheetTitle>
            {p && <span className="truncate text-sm text-muted-foreground">{p.name}</span>}
            {p && (
              <Badge className={cn('border-0', open ? 'bg-primary/12 text-up' : (p.netPnlIsk ?? 0) > 0 ? 'bg-up/10 text-up' : 'bg-down/10 text-down')} variant="secondary">
                {open ? 'Open position' : (p.netPnlIsk ?? 0) > 0 ? 'Closed · win' : 'Closed · loss'}
              </Badge>
            )}
            <Badge className="border-0 bg-amber-400/10 text-amber-300" variant="secondary">Simulated</Badge>
          </div>
          <SheetDescription className="sr-only">Market price chart and simulated fills for this position. Read-only.</SheetDescription>
          {p && (
            <div className="flex flex-wrap items-center gap-2">
              <CopyAddress value={p.tokenAddress} />
              <a className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" href={`https://www.geckoterminal.com/solana/pools/${p.pairAddress}`} rel="noreferrer" target="_blank">
                GeckoTerminal <ExternalLinkIcon className="size-3" />
              </a>
              <a className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" href={`https://dexscreener.com/solana/${p.pairAddress}`} rel="noreferrer" target="_blank">
                DexScreener <ExternalLinkIcon className="size-3" />
              </a>
            </div>
          )}
        </SheetHeader>

        <div className="flex flex-col gap-5 px-3 pb-8 sm:px-8">
          <div className="rounded-2xl bg-card p-2 sm:p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 px-2 pt-1 pb-2">
              <SlidingTabs
                label="Chart timeframe"
                onChange={(v) => setTf(v)}
                options={TFS.map((t) => ({ value: t, label: t }))}
                value={(shownTf ?? '5m') as Tf}
              />
              <span className="text-[11px] text-muted-foreground">
                {data?.pool ? `${data.pool.name} · ${unit}` : ''}
                {loading && data ? ' · updating…' : ''}
              </span>
            </div>
            <div className="relative h-[320px] sm:h-[440px]">
              {candles.length > 0 && shownTf && (
                <div className={cn('h-full transition-opacity duration-(--duration-slow) ease-(--ease-smooth-out) motion-reduce:transition-none', ready ? 'opacity-100' : 'opacity-0')}>
                  <CandleChart candles={candles} focus={focus} levels={levels} markers={markers} onReady={onReady} tf={shownTf} unit={unit} viewKey={`${positionId}:${shownTf}`} />
                </div>
              )}
              {(!tfMatches || loading) && candles.length === 0 && !chartErr && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="t-shimmer text-sm" data-text="Loading market data…">Loading market data…</span>
                </div>
              )}
              {tfMatches && !loading && !chartErr && candles.length === 0 && (
                <Notice text="No historical candles are available for this pool and timeframe. Nothing is shown rather than an estimated chart." />
              )}
              {chartErr && candles.length === 0 && (
                <Notice
                  action={<Button onClick={reload} size="sm" variant="secondary"><RefreshCwIcon /> Retry{retryAfter ? ` (wait ~${retryAfter}s)` : ''}</Button>}
                  text={`Couldn't load candles: ${chartErr}`}
                />
              )}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 px-2 pt-2 text-[11px] text-muted-foreground">
              <Key color="#00d49a" dashed label="Take profit" />
              <Key color="#f0616d" dashed label="Stop loss" />
              <Key color="rgba(245,245,247,0.7)" dashed label="Entry fill" />
              {exit && <Key color="#e8b04b" dashed label="Exit fill" />}
              {data?.chart.truncated && <span>Window limited to 1000 candles; pick a larger timeframe to see the whole trade.</span>}
            </div>
          </div>

          {p && (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Entry fill (simulated)" sub={dateTime(entry?.ts ?? p.openedAt)}>{fmtPx(entry?.fillPriceSol ?? p.entryPriceSol)}</Stat>
                {open ? (
                  <Stat label="Current price" sub={live?.changePct != null ? `${pct(live.changePct)} vs entry${live.markFresh ? '' : ' · stale'}` : undefined}>
                    {markSol != null ? <SubtleNumber text={fmtPx(markSol)} value={markSol} /> : '—'}
                  </Stat>
                ) : (
                  <Stat label="Exit fill (simulated)" sub={p.closedAt ? dateTime(p.closedAt) : undefined}>{fmtPx(exit?.fillPriceSol)}</Stat>
                )}
                <Stat cls={tone(pnl)} label={open ? 'Unrealized P/L' : 'Net P/L'} sub="after fees and slippage">
                  {pnl != null ? <SubtleNumber text={isk(pnl, true)} value={pnl} /> : '—'}
                </Stat>
                <Stat label="Duration" sub={open ? 'still open' : p.exitReason?.split(':')[0]}>{duration(durationMs)}</Stat>
                <Stat cls="text-down" label="Stop loss">{fmtPx(p.slPriceSol)}</Stat>
                <Stat cls="text-up" label="Take profit">{fmtPx(p.tpPriceSol)}</Stat>
                <Stat label="Position size" sub={`${Math.round(p.tokenAmount).toLocaleString('en-US')} ${p.symbol}`}>{isk(p.costIsk)}</Stat>
                <Stat label="Liquidity" sub={data?.pool?.dex ?? undefined}>{usd(data?.pool?.liquidityUsd)}</Stat>
                <Stat label="Volume 24h">{usd(data?.pool?.volume24hUsd)}</Stat>
                <Stat label={data?.pool?.marketCapUsd != null ? 'Market cap' : 'FDV'}>{usd(data?.pool?.marketCapUsd ?? data?.pool?.fdvUsd)}</Stat>
              </div>

              <div className="overflow-hidden rounded-2xl bg-card">
                <p className="px-5 pt-4 pb-2 text-sm font-medium">Simulated executions</p>
                <div className="overflow-x-auto">
                  <table className="num w-full min-w-[560px] text-xs">
                    <thead className="text-muted-foreground">
                      <tr className="[&>th]:px-5 [&>th]:py-2 [&>th]:text-left [&>th]:font-normal">
                        <th>Time</th><th>Side</th><th>Market mark</th><th>Simulated fill</th><th>Slippage</th><th>Fee</th><th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data!.trades.map((t) => (
                        <tr className="border-t border-border [&>td]:px-5 [&>td]:py-2.5" key={t.id}>
                          <td className="text-muted-foreground">{dateTime(t.ts)}</td>
                          <td className={t.side === 'BUY' ? 'text-up' : 'text-amber-300'}>{t.side}</td>
                          <td>{price(t.markPriceSol)}</td>
                          <td className="font-medium">{t.fillPriceSol != null ? price(t.fillPriceSol) : '—'}</td>
                          <td className="text-muted-foreground">{t.slippageIsk.toFixed(1)} ISK</td>
                          <td className="text-muted-foreground">{t.feeIsk.toFixed(2)} ISK</td>
                          <td className={t.status === 'FAILED' ? 'text-down' : 'text-muted-foreground'}>{t.status === 'FAILED' ? `Failed: ${t.failReason ?? ''}` : 'Filled'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">
                Candles are real {data?.chart.source} market data for pool <span className="font-mono">{p.pairAddress.slice(0, 6)}…{p.pairAddress.slice(-4)}</span>, priced in {unit}.
                Fills, stop loss and take profit are the paper-trading engine's simulated prices (SOL){unit === 'USD' ? ', converted to USD with the SOL rate recorded at each fill' : ''}.
                Small gaps between a fill and the candle range come from the engine pricing off DexScreener and Jupiter at that moment. This chart is read-only and cannot place trades.
              </p>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Notice({ text, action }: { text: string; action?: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="max-w-sm text-sm text-pretty text-muted-foreground">{text}</p>
      {action}
    </div>
  );
}

function Key({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden="true" className={cn('h-0 w-3.5 border-t', dashed && 'border-dashed')} style={{ borderColor: color }} />
      {label}
    </span>
  );
}
