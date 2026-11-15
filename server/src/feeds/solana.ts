import { getJson } from './http.ts';

/** Known AMM authority owners whose token accounts are liquidity vaults, not holders. */
const AMM_AUTHORITIES = new Set([
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium AMM v4
  'GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL', // Raydium CPMM
  'WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh', // Raydium LaunchLab
]);

export interface TokenSafety {
  decimals: number;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** % of supply in the 10 largest non-pool accounts (approximate: unknown pool programs are counted as holders). */
  top10Pct: number;
  top1Pct: number;
  /** Where the concentration figure came from. */
  concentrationSource?: string;
  checkedAt: number;
}

/** Fallback concentration source when the public RPC throttles getTokenLargestAccounts. */
export async function geckoTop10Pct(mint: string): Promise<number> {
  const r = await getJson<{ data: { attributes: { holders?: { distribution_percentage?: { top_10?: string } } } } }>(
    `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/info`,
  );
  const v = Number(r.data?.attributes?.holders?.distribution_percentage?.top_10);
  if (!Number.isFinite(v)) throw new Error('GeckoTerminal: no holder distribution');
  return v;
}

/** Read-only public RPC calls. No keys, no signing. */
export class SolanaRpc {
  url: string;
  constructor(url: string) {
    this.url = url;
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const r = await getJson<{ result?: T; error?: { message: string } }>(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (r.error) throw new Error(`RPC ${method}: ${r.error.message}`);
    return r.result as T;
  }

  async safety(mint: string, pairAddress: string): Promise<TokenSafety> {
    type Parsed = { value: { data: { parsed: { info: Record<string, unknown> } } } | null };
    const acct = await this.call<Parsed>('getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
    const info = acct.value?.data?.parsed?.info;
    if (!info) throw new Error('mint account not parsable');
    const decimals = Number(info.decimals);
    const supply = Number(info.supply) / 10 ** decimals;

    const base = {
      decimals,
      mintAuthority: (info.mintAuthority as string) ?? null,
      freezeAuthority: (info.freezeAuthority as string) ?? null,
    };
    let largest: { value: { address: string; uiAmount: number | null }[] };
    try {
      largest = await this.call('getTokenLargestAccounts', [mint]);
    } catch {
      // Public RPC heavily throttles this call; fall back to GeckoTerminal's holder distribution.
      const top10 = await geckoTop10Pct(mint);
      return { ...base, top10Pct: top10, top1Pct: NaN, concentrationSource: 'GeckoTerminal holder distribution', checkedAt: Date.now() };
    }
    const accts = largest.value.slice(0, 20);
    const owners = await this.call<{ value: ({ data: { parsed: { info: { owner: string } } } } | null)[] }>(
      'getMultipleAccounts',
      [accts.map((a) => a.address), { encoding: 'jsonParsed' }],
    );
    const holders: number[] = [];
    accts.forEach((a, i) => {
      const owner = owners.value[i]?.data?.parsed?.info?.owner;
      if (owner && (owner === pairAddress || AMM_AUTHORITIES.has(owner))) return; // pool vault
      holders.push(a.uiAmount ?? 0);
    });
    const top10 = holders.slice(0, 10).reduce((s, x) => s + x, 0);
    return {
      ...base,
      top10Pct: supply > 0 ? (top10 / supply) * 100 : 100,
      top1Pct: supply > 0 ? ((holders[0] ?? 0) / supply) * 100 : 100,
      concentrationSource: 'Solana RPC largest accounts (excl. known pool vaults)',
      checkedAt: Date.now(),
    };
  }
}
