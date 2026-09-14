/**
 * Pure helpers for the machine-facing AgentGate order API.
 *
 * No Convex imports, no I/O, WebCrypto only (available in Convex's HTTP and
 * Node runtimes, Node 18+, and vitest) so this module can be imported by the
 * HTTP router, Node actions, and the unit-test suite alike.
 *
 * Capability-token design: a 256-bit cryptographically random token returned
 * exactly once by POST /api/orders. Only its SHA-256 hash is ever persisted;
 * access to an order requires presenting the raw token, whose hash must match
 * the stored hash. Wrong/missing tokens are answered with the same 404 as a
 * nonexistent order — the two are indistinguishable.
 */

const encoder = new TextEncoder();

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Hex string containing only [0-9a-f]. */
export function isHex64(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}

/** 256-bit cryptographically random capability token, lowercase hex. */
export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/** SHA-256 of the raw capability token as lowercase hex. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return toHex(new Uint8Array(digest));
}

/**
 * Constant-time comparison of two 64-char hex strings: always scans every
 * character regardless of where a mismatch occurs, and rejects malformed
 * input outright.
 */
export function constantTimeHexEqual(a: string, b: string): boolean {
  if (!isHex64(a) || !isHex64(b)) return false;
  let diff = 0;
  for (let i = 0; i < 64; i++) {
    diff |= (a.charCodeAt(i) ?? 0) ^ (b.charCodeAt(i) ?? 0);
  }
  return diff === 0;
}

/**
 * Generate a new capability token and its storage hash. The raw token is
 * shown to the caller exactly once by the HTTP handler and never persisted.
 */
export async function generateOrderToken(): Promise<{
  token: string;
  tokenHash: string;
}> {
  const token = randomToken();
  return { token, tokenHash: await hashToken(token) };
}

// ---------------------------------------------------------------------------
// Execution failure classification + retry authorization (pure decision
// logic for the paid-order retry path; unit-tested in agentgate-machine.test).
//
// Design: a transient provider/infrastructure failure (timeout, abort,
// network error, HTTP 429/5xx from a provider) after CONFIRMED payment must
// not permanently burn a paid order. Permanent/contract failures (insufficient
// verifiable sources, price mismatch, postcondition violations, integrity
// errors) stay terminal so a genuinely unservable order can never loop.
// ---------------------------------------------------------------------------

/**
 * True when an execution error message indicates a TRANSIENT provider or
 * infrastructure failure that is safe to retry. Deliberately conservative:
 * anything not recognized as transient is treated as permanent.
 */
export function isTransientExecutionError(message: string): boolean {
  const m = message.toLowerCase();
  if (
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("aborted") ||
    m.includes("econn") ||
    m.includes("enotfound") ||
    m.includes("eai_again") ||
    m.includes("econnreset") ||
    m.includes("fetch failed") ||
    m.includes("network") ||
    m.includes("temporarily unavailable") ||
    m.includes("service unavailable") ||
    m.includes("rate limit")
  ) {
    return true;
  }
  // Provider-side HTTP 429/5xx are transient; 4xx are not.
  const httpMatch = m.match(/\bhttp (4\d\d|5\d\d)\b/);
  if (!httpMatch) return false;
  return httpMatch[1]!.startsWith("5") || httpMatch[1] === "429";
}

/**
 * Authorization decision for the one-shot execution claim.
 * Enforces the payment gate: only orders with PERSISTED payment confirmation
 * evidence (paymentConfirmedAt) may execute — no state string alone is ever
 * sufficient.
 */
export function evaluateExecutionClaim(
  order: {
    status: string;
    paymentConfirmedAt?: number;
    executionStartedAt?: number;
  },
  staleClaimMs: number,
): { ok: boolean; reason?: string } {
  // Hard payment gate: without persisted confirmation evidence, NO order —
  // in any state — may enter execution. This is what makes the retry path
  // unusable by unpaid orders.
  if (order.paymentConfirmedAt === undefined) {
    return { ok: false, reason: "not_paid" };
  }
  if (order.status === "payment_confirmed") {
    return { ok: true };
  }
  if (order.status === "executing") {
    const startedAt = order.executionStartedAt ?? order.paymentConfirmedAt;
    if (startedAt !== undefined && Date.now() - startedAt <= staleClaimMs) {
      return { ok: false, reason: "already_executing" };
    }
    // Stale claim (crashed previous run): reclaimable.
    return { ok: true };
  }
  if (order.status === "failed_retriable") {
    return { ok: true }; // paid transient failure: retry via the normal claim
  }
  return { ok: false, reason: `not_claimable_from_${order.status}` };
}

/**
 * Authorization decision for recovering a LEGACY `failed` order (burned under
 * the pre-retry state machine) onto the retry path. Requires ALL of: the
 * order is currently `failed`, payment was genuinely confirmed (persisted
 * evidence), and the recorded error classifies as transient. A permanent
 * failure or an unpaid order can never be recovered.
 */
export function evaluateFailureRecovery(order: {
  status: string;
  paymentConfirmedAt?: number;
  error: string;
}): { ok: boolean; reason?: string } {
  if (order.paymentConfirmedAt === undefined) {
    return { ok: false, reason: "not_paid" };
  }
  if (order.status !== "failed") {
    return { ok: false, reason: `not_recoverable_from_${order.status}` };
  }
  if (!isTransientExecutionError(order.error)) {
    return { ok: false, reason: "failure_not_transient" };
  }
  return { ok: true };
}

/** Validate the machine order request body for POST /api/orders. */
export function validateOrderRequest(body: {
  query?: unknown;
}): { ok: true; query: string } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "request body must be a JSON object" };
  }
  if (typeof body.query !== "string") {
    return { ok: false, error: "query is required and must be a string" };
  }
  const q = body.query.trim();
  if (q.length < 8 || body.query.length > 512) {
    return {
      ok: false,
      error: "query must be between 8 and 512 characters",
    };
  }
  return { ok: true, query: q };
}
