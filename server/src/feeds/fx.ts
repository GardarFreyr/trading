import { getJson } from './http.ts';

/** USD → ISK reference rate (free, updated daily by the provider). */
export async function fetchIskPerUsd(url: string): Promise<{ rate: number; asOf: number }> {
  const r = await getJson<{ result: string; rates: Record<string, number>; time_last_update_unix: number }>(url);
  const rate = r.rates?.ISK;
  if (r.result !== 'success' || !(rate > 0)) throw new Error('FX: ISK rate missing');
  return { rate, asOf: r.time_last_update_unix * 1000 };
}
