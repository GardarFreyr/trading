import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { Store } from './db.ts';

/**
 * Single-engine lease stored in the database itself.
 *
 * Only the engine holding the lease may trade. The holder renews it every tick;
 * if it stops renewing (crash, kill -9), another engine may take over once the
 * lease is older than LEASE_TTL_MS. A clean shutdown releases it immediately.
 */
export const LEASE_TTL_MS = 90_000;
const KEY = 'engine_lease';

export interface LeaseInfo {
  owner: string;
  label: string;
  heartbeat: number;
  acquiredAt: number;
}

export function newOwnerId(): string {
  return `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
}

export function readLease(store: Store): LeaseInfo | null {
  const v = store.kvGet(KEY);
  return v ? (JSON.parse(v) as LeaseInfo) : null;
}

/** Acquire or renew the lease atomically. Returns the current holder after the attempt. */
export function claimLease(store: Store, owner: string, label: string, now: number): { held: boolean; holder: LeaseInfo } {
  return store.tx(() => {
    const cur = readLease(store);
    const free = !cur || cur.owner === owner || now - cur.heartbeat > LEASE_TTL_MS;
    if (!free) return { held: false, holder: cur! };
    const next: LeaseInfo = { owner, label, heartbeat: now, acquiredAt: cur?.owner === owner ? cur.acquiredAt : now };
    store.kvSet(KEY, JSON.stringify(next));
    return { held: true, holder: next };
  });
}

export function releaseLease(store: Store, owner: string) {
  store.tx(() => {
    if (readLease(store)?.owner === owner) store.db.prepare('DELETE FROM kv WHERE key=?').run(KEY);
  });
}
