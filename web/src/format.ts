export const isk = (n: number | null | undefined, signed = false) => {
  if (n == null || !Number.isFinite(n)) return '—';
  const s = Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const sign = n < 0 ? '−' : signed && n > 0 ? '+' : '';
  return `${sign}${s} ISK`;
};

export const pct = (n: number | null | undefined, digits = 2, signed = true) => {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n < 0 ? '−' : signed && n > 0 ? '+' : '';
  return `${sign}${Math.abs(n).toFixed(digits)}%`;
};

export const usd = (n: number | null | undefined) => {
  if (n == null) return '—';
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
};

/** Small prices: 0.0₄1832 style subscript-zero notation. */
export const price = (n: number | null | undefined) => {
  if (n == null || !Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1) return n.toFixed(4);
  const s = n.toFixed(20);
  const m = s.match(/^0\.(0*)(\d{4})/);
  if (!m) return n.toPrecision(4);
  const z = m[1].length;
  if (z < 3) return n.toFixed(z + 4);
  const sub = String(z).split('').map((d) => '₀₁₂₃₄₅₆₇₈₉'[Number(d)]).join('');
  return `0.0${sub}${m[2]}`;
};

export const time = (ts: number) => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const dateTime = (ts: number) =>
  new Date(ts).toLocaleString('en-GB', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });

export const ago = (ts: number | null, now: number) => {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

export const duration = (ms: number) => {
  if (ms <= 0) return '0m';
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return d > 0 ? `${d}d ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

export const tone = (n: number | null | undefined) => (n == null ? '' : n > 0 ? 'text-up' : n < 0 ? 'text-down' : '');
