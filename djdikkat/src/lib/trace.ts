/************************************************************
 * DJ DIKKAT - Music Bot
 * Request IDs
 * One id per interaction or internal API call, carried through
 * every await so each log line can be traced back to it (the
 * website passes its nginx request id in X-Request-ID).
 * Author: Yanoee
 ************************************************************/
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

const store = new AsyncLocalStorage<string>();
const VALID = /^[A-Za-z0-9-]{8,64}$/;

/** The incoming id when it looks sane, else a fresh one. */
export function requestId(incoming?: unknown): string {
  return typeof incoming === 'string' && VALID.test(incoming) ? incoming : randomBytes(4).toString('hex');
}

export const currentRequestId = (): string | undefined => store.getStore();

export function withRequestId<T>(id: string, fn: () => T): T {
  return store.run(id, fn);
}
