/**
 * Shared sessionId rule for `POST /api/critique` and `POST /api/speech`.
 *
 * A sessionId is echoed in the `X-Session-Id` response header, so it must be a
 * valid header value: printable ASCII only (no control characters, no CR/LF,
 * no non-Latin-1 characters, which would make `new Headers()` throw).
 * Both routes use the same rule so any id the critique route accepts can be spoken.
 */

export const SESSION_ID_MAX_CHARS = 128;

const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/** Non-empty after trimming, at most 128 characters, printable ASCII only. */
export function isValidSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= SESSION_ID_MAX_CHARS &&
    PRINTABLE_ASCII.test(value)
  );
}

/** Validation error message; `field` names the JSON path. */
export function sessionIdErrorMessage(field = "sessionId"): string {
  return `${field} must be a non-empty string of at most ${SESSION_ID_MAX_CHARS} printable ASCII characters`;
}
