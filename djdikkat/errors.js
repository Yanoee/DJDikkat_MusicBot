/************************************************************
 * DJ DIKKAT - Music Bot
 * Errors
 * Structured application errors with codes + correlation IDs
 * Build 4.0.0
 * Author: Yanoee
 ************************************************************/
const crypto = require('crypto');

function makeRef() {
  return crypto.randomBytes(3).toString('hex'); // e.g. "a3f9c2"
}

// Catalog of known error codes — the source of truth for what codes exist,
// so call sites reuse the same vocabulary instead of inventing tags ad hoc.
const ErrorCodes = {
  NODELINK_UNAVAILABLE: 'NODELINK_UNAVAILABLE',
  RECOVERY_FAILED:      'RECOVERY_FAILED',
  TRACK_EXCEPTION:      'TRACK_EXCEPTION',
  TRACK_STUCK:          'TRACK_STUCK',
  SPOTIFY_ERROR:        'SPOTIFY_ERROR',
  UNEXPECTED:           'UNEXPECTED'
};

/**
 * A deliberate, user-safe message — not a bug, just expected control flow
 * ("join a voice channel first"). Shown to the user verbatim: no ref code,
 * no [CODE]-tagged log noise, because there's nothing to trace or fix.
 */
class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
  }
}

/**
 * An internal/unexpected failure. Gets a short correlation ref and a code so
 * "it broke, ref: a3f9c2" from a user can be grepped straight to the exact
 * bot.log line, without exposing raw stack/internal detail to that user.
 */
class AppError extends Error {
  constructor(code, message, context = {}, cause = null) {
    super(message);
    this.name = 'AppError';
    this.code = code || ErrorCodes.UNEXPECTED;
    this.context = context;
    this.cause = cause;
    this.ref = makeRef();
  }
}

/**
 * Logs an AppError (or wraps any other thrown value into one) as a single
 * consistent line — [CODE] message (ref: xxxxxx) {context} — plus the full
 * original error/stack on the line below when one exists, for deep debugging.
 * Returns the AppError so callers can surface `.ref` to the user.
 */
function logError(err, fallbackContext = {}) {
  const appErr = err instanceof AppError
    ? err
    : new AppError(ErrorCodes.UNEXPECTED, err?.message || String(err), fallbackContext, err);

  const ctx = appErr.context && Object.keys(appErr.context).length ? ` ${JSON.stringify(appErr.context)}` : '';
  console.error(`❌ [${appErr.code}] ${appErr.message} (ref: ${appErr.ref})${ctx}`);
  if (appErr.cause && appErr.cause !== appErr) {
    console.error(appErr.cause);
  }
  return appErr;
}

module.exports = { UserError, AppError, ErrorCodes, logError };
