import type { Config } from './config.ts';
import type { Feeds } from './engine.ts';
import { DexScreener } from './feeds/dexscreener.ts';
import { Jupiter } from './feeds/jupiter.ts';
import { SolanaRpc } from './feeds/solana.ts';
import { fetchIskPerUsd } from './feeds/fx.ts';
import { getJson } from './feeds/http.ts';

/** Optional extra DISCOVERY source (token addresses only; prices always come from DexScreener). */
async function geckoTrending(url: string): Promise<string[]> {
  const r = await getJson<{ data: { relationships: { base_token: { data: { id: string } } } }[] }>(url);
  return r.data.map((p) => p.relationships.base_token.data.id.replace(/^solana_/, ''));
}

/** Real, read-only market data feeds. Nothing here can sign or send a transaction. */
export function liveFeeds(cfg: Config): Feeds {
  const dex = new DexScreener(cfg.dexscreenerBase);
  const jup = new Jupiter(cfg.jupiterQuoteUrl, cfg.slippageToleranceBps);
  const rpc = new SolanaRpc(cfg.solanaRpcUrl);
  return {
    discover: async () => {
      const [a, b] = await Promise.allSettled([
        dex.discover(),
        cfg.trendingDiscoveryUrl ? geckoTrending(cfg.trendingDiscoveryUrl) : Promise.resolve([]),
      ]);
      if (a.status === 'rejected' && b.status === 'rejected') throw a.reason;
      return [...new Set([...(b.status === 'fulfilled' ? b.value : []), ...(a.status === 'fulfilled' ? a.value : [])])];
    },
    markets: (a) => dex.markets(a),
    quote: (i, o, raw, d) => jup.quote(i, o, raw, d),
    safety: (m, p) => rpc.safety(m, p),
    iskPerUsd: () => fetchIskPerUsd(cfg.fxUrl),
  };
}
