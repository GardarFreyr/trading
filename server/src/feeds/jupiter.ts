import { getJson } from './http.ts';

export interface JupQuote {
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: { swapInfo: { label?: string } }[];
}

export interface Quote {
  /** Output in UI units (SOL for sells, tokens for buys). */
  outAmount: number;
  priceImpactPct: number;
  route: string;
  source: 'jupiter';
}

/** Read-only Jupiter quotes. Never builds or signs a transaction. */
export class Jupiter {
  url: string;
  slippageBps: number;
  constructor(url: string, slippageBps: number) {
    this.url = url;
    this.slippageBps = slippageBps;
  }

  async quote(inputMint: string, outputMint: string, rawAmount: bigint, outDecimals: number): Promise<Quote> {
    const q = new URLSearchParams({
      inputMint,
      outputMint,
      amount: rawAmount.toString(),
      slippageBps: String(this.slippageBps),
      swapMode: 'ExactIn',
    });
    const r = await getJson<JupQuote & { error?: string }>(`${this.url}?${q}`, {}, 8_000);
    if (r.error || !r.outAmount) throw new Error(`Jupiter: ${r.error ?? 'no route'}`);
    return {
      outAmount: Number(r.outAmount) / 10 ** outDecimals,
      priceImpactPct: Math.abs(Number(r.priceImpactPct ?? 0)) * 100,
      route: r.routePlan.map((x) => x.swapInfo.label ?? '?').join(' → '),
      source: 'jupiter',
    };
  }
}
