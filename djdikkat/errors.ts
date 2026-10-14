/************************************************************
 * DJ DIKKAT - Music Bot
 * Errors
 * Structured application errors with codes + correlation IDs
 * Build 5.3.1
 * Author: Yanoee
 ************************************************************/
import { randomBytes } from 'node:crypto';

// Every known error code — call sites reuse this vocabulary instead of
// inventing tags ad hoc (the compiler rejects anything else).
export type ErrorCode = 'NODELINK_UNAVAILABLE' | 'RECOVERY_FAILED' | 'TRACK_EXCEPTION' | 'TRACK_STUCK' | 'SPOTIFY_ERROR' | 'UNEXPECTED';

/**
 * A deliberate, user-safe message — not a bug, just expected control flow
 * ("join a voice channel first"). Shown to the user verbatim: no ref code,
 * no [CODE]-tagged log noise, because there's nothing to trace or fix.
 */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

/**
 * An internal/unexpected failure. Gets a short correlation ref and a code so
 * "it broke, ref: a3f9c2" from a user can be grepped straight to the exact
 * bot.log line, without exposing raw stack/internal detail to that user.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly context: Record<string, unknown>;
  readonly ref = randomBytes(3).toString('hex');

  constructor(code: ErrorCode, message: string, context: Record<string, unknown> = {}, cause?: unknown) {
    super(message, { cause });
    this.name = 'AppError';
    this.code = code;
    this.context = context;
  }
}

/**
 * Logs an AppError (or wraps any other thrown value into one) as a single
 * consistent line — [CODE] message (ref: xxxxxx) {context} — plus the full
 * original error/stack on the line below when one exists, for deep debugging.
 * Returns the AppError so callers can surface `.ref` to the user.
 */
export function logError(err: unknown, fallbackContext: Record<string, unknown> = {}): AppError {
  const appErr = err instanceof AppError
    ? err
    : new AppError('UNEXPECTED', err instanceof Error ? err.message : String(err), fallbackContext, err);

  const ctx = Object.keys(appErr.context).length ? ` ${JSON.stringify(appErr.context)}` : '';
  console.error(`❌ [${appErr.code}] ${appErr.message} (ref: ${appErr.ref})${ctx}`);
  if (appErr.cause && appErr.cause !== appErr) console.error(appErr.cause);
  return appErr;
}

/** Message of anything thrown. */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
