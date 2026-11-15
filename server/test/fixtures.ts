import type { Market } from '../src/feeds/dexscreener.ts';
import type { Feeds } from '../src/engine.ts';
import { SOL_MINT } from '../src/config.ts';

export function market(address: string, priceUsd: number, now: number, o: Partial<Market> = {}): Market {
  return {
    address,
    symbol: address.slice(0, 6),
    name: address,
    pairAddress: `pair-${address}`,
    dexId: 'raydium',
    priceUsd,
    liquidityUsd: 250_000,
    fdvUsd: 2_000_000,
    volume: { m5: 20_000, h1: 120_000, h6: 500_000, h24: 1_500_000 },
    change: { m5: 3, h1: 15, h6: 20, h24: 30 },
    txns: { m5: { buys: 40, sells: 20 }, h1: { buys: 400, sells: 250 }, h24: { buys: 4000, sells: 3500 } },
    pairCreatedAt: now - 24 * 3_600_000,
    fetchedAt: now,
    ...o,
  };
}

/** Controllable fake world: prices, outages and quote spreads are set by the test. */
export class FakeWorld implements Feeds {
  now: () => number;
  prices = new Map<string, number>();
  overrides = new Map<string, Partial<Market>>();
  solUsd = 100;
  down = false;
  quoteHaircut = 0.01; // Jupiter quotes 1% worse than mark each way
  quotes = 0;

  constructor(now: () => number) {
    this.now = now;
  }
  async discover() {
    if (this.down) throw new Error('down');
    return [...this.prices.keys()];
  }
  async markets(addresses: string[]) {
    if (this.down) throw new Error('down');
    const m = new Map<string, Market>();
    const t = this.now();
    for (const a of addresses) {
      if (a === SOL_MINT) m.set(a, market(a, this.solUsd, t, { symbol: 'SOL' }));
      else if (this.prices.has(a)) m.set(a, market(a, this.prices.get(a)!, t, this.overrides.get(a)));
    }
    return m;
  }
  async quote(inputMint: string, outputMint: string, raw: bigint, outDecimals: number) {
    this.quotes++;
    if (this.down) throw new Error('down');
    const buying = inputMint === SOL_MINT;
    const token = buying ? outputMint : inputMint;
    const markSol = this.prices.get(token)! / this.solUsd;
    const inUi = Number(raw) / 10 ** (buying ? 9 : 6);
    const out = buying ? (inUi / markSol) * (1 - this.quoteHaircut) : inUi * markSol * (1 - this.quoteHaircut);
    void outDecimals;
    return { outAmount: out, priceImpactPct: 0.5, route: 'fake', source: 'jupiter' as const };
  }
  async safety() {
    return { decimals: 6, mintAuthority: null, freezeAuthority: null, top10Pct: 20, top1Pct: 5, checkedAt: this.now() };
  }
  async iskPerUsd() {
    if (this.down) throw new Error('down');
    return { rate: 125, asOf: this.now() };
  }
}
