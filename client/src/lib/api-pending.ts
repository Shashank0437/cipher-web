/** Client-only in-flight counts for REST calls (see api.ts bump). SSR snapshot is always zero. */

let count = 0;
const listeners = new Set<() => void>();

export function subscribeApiPending(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getApiPendingSnapshot(): number {
  return count;
}

export function bumpApiPending(delta: number): void {
  count = Math.max(0, count + delta);
  listeners.forEach((l) => l());
}
