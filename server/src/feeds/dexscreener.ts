import { getJson } from './http.ts';

export interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceNative?: string;
  priceUsd?: string;
  txns?: Record<'m5' | 'h1' | 'h6' | 'h24', { buys: number; sells: number }>;
  volume?: Partial<Record<'m5' | 'h1' | 'h6' | 'h24', number>>;
  priceChange?: Partial<Record<'m5' | 'h1' | 'h6' | 'h24', number>>;
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  labels?: string[];
}

/** Normalised market view of one token, from its most liquid Solana pair. */
export interface Market {
  address: string;
  symbol: string;
  name: string;
  pairAddress: string;
  dexId: string;
  priceUsd: number;
  liquidityUsd: number;
  fdvUsd: number;
  volume: { m5: number; h1: number; h6: number; h24: number };
  change: { m5: number; h1: number; h6: number; h24: number };
  txns: { m5: { buys: number; sells: number }; h1: { buys: number; sells: number }; h24: { buys: number; sells: number } };
  pairCreatedAt: number | null;
  fetchedAt: number;
}

interface Listing {
  chainId: string;
  tokenAddress: string;
}

export class DexScreener {
  base: string;
  constructor(base: string) {
    this.base = base;
  }

  /** Newly promoted / profiled Solana tokens. Each source is optional; at least one must succeed. */
  async discover(): Promise<string[]> {
    const paths = ['/token-profiles/latest/v1', '/token-boosts/latest/v1', '/token-boosts/top/v1'];
    const results = await Promise.allSettled(paths.map((p) => getJson<Listing[]>(this.base + p)));
    const ok = results.filter((r): r is PromiseFulfilledResult<Listing[]> => r.status === 'fulfilled');
    if (ok.length === 0) throw (results[0] as PromiseRejectedResult).reason;
    const out = new Set<string>();
    for (const r of ok) {
      if (!Array.isArray(r.value)) continue;
      for (const l of r.value) if (l.chainId === 'solana' && l.tokenAddress) out.add(l.tokenAddress);
    }
    return [...out];
  }

  /** Fetch best pair per token (max 30 addresses per request). */
  async markets(addresses: string[]): Promise<Map<string, Market>> {
    const out = new Map<string, Market>();
    for (let i = 0; i < addresses.length; i += 30) {
      const chunk = addresses.slice(i, i + 30);
      const pairs = await getJson<DexPair[]>(`${this.base}/tokens/v1/solana/${chunk.join(',')}`);
      const now = Date.now();
      for (const addr of chunk) {
        const m = bestMarket(addr, Array.isArray(pairs) ? pairs : [], now);
        if (m) out.set(addr, m);
      }
    }
    return out;
  }
}

export function bestMarket(address: string, pairs: DexPair[], fetchedAt: number): Market | null {
  const candidates = pairs.filter(
    (p) => p.chainId === 'solana' && p.baseToken?.address === address && Number(p.priceUsd) > 0,
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const p = candidates[0];
  const t = (k: 'm5' | 'h1' | 'h24') => ({ buys: p.txns?.[k]?.buys ?? 0, sells: p.txns?.[k]?.sells ?? 0 });
  return {
    address,
    symbol: p.baseToken.symbol,
    name: p.baseToken.name,
    pairAddress: p.pairAddress,
    dexId: p.dexId,
    priceUsd: Number(p.priceUsd),
    liquidityUsd: p.liquidity?.usd ?? 0,
    fdvUsd: p.fdv ?? p.marketCap ?? 0,
    volume: { m5: p.volume?.m5 ?? 0, h1: p.volume?.h1 ?? 0, h6: p.volume?.h6 ?? 0, h24: p.volume?.h24 ?? 0 },
    change: {
      m5: p.priceChange?.m5 ?? 0,
      h1: p.priceChange?.h1 ?? 0,
      h6: p.priceChange?.h6 ?? 0,
      h24: p.priceChange?.h24 ?? 0,
    },
    txns: { m5: t('m5'), h1: t('h1'), h24: t('h24') },
    pairCreatedAt: p.pairCreatedAt ?? null,
    fetchedAt,
  };
}
