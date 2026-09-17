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

import { RESEARCH_SERVICE } from "./agentgate-contract";

const encoder = new TextEncoder();

/**
 * Pure projection of the PUBLIC PROOF surface for GET /api/proof/:orderId.
 *
 * Security model: the order id is an OPAQUE PUBLIC PROOF IDENTIFIER, not a
 * capability. Security comes from the endpoint being strictly read-only and
 * this allowlist projection — the proof can only ever expose evidence
 * fields, never capability tokens/hashes, user/session identity, the live
 * checkout/payment URL, internal error details, or arbitrary order fields.
 * The allowlist is enforced HERE (pure, unit-tested), not at the call site.
 */
/** Exact top-level fields exposed by GET /api/proof/:orderId. */
export const PROOF_FIELDS = [
  "orderId",
  "serviceId",
  "amount",
  "currency",
  "paymentLinkId",
  "paymentStatus",
  "transactionUrl",
  "executionStatus",
  "executionAttempts",
  "executedMs",
  "slaTargetMs",
  "slaNote",
  "query",
  "result",
  "resultHash",
] as const;

export type PublicProof = Record<(typeof PROOF_FIELDS)[number], unknown>;

/**
 * Build the public proof payload from PERSISTED transaction data.
 * `result` is passed through AS PERSISTED (the canonical receipt/result
 * object) — never reconstructed — so JSON key ordering is unchanged and
 * sha256(JSON.stringify(result)) reproduces the persisted resultHash.
 */
export function buildPublicProof(input: {
  orderId: string;
  serviceId: string;
  amount: string;
  currency: string;
  paymentLinkId: string | null;
  paymentStatus: string | null;
  transactionUrl: string | null;
  executionStatus: string;
  executionAttempts: number | null;
  executedMs: number | null;
  query: string;
  result: unknown | null;
}): PublicProof {
  return {
    orderId: input.orderId,
    serviceId: input.serviceId,
    amount: input.amount,
    currency: input.currency,
    paymentLinkId: input.paymentLinkId,
    paymentStatus: input.paymentStatus ?? "unknown",
    transactionUrl: input.transactionUrl,
    executionStatus: input.executionStatus,
    executionAttempts: input.executionAttempts,
    executedMs: input.executedMs,
    slaTargetMs: RESEARCH_SERVICE.execution.slaTargetMs,
    slaNote: RESEARCH_SERVICE.execution.slaNote,
    query: input.query,
    result: input.result,
    resultHash: null,
  };
}

/** SHA-256 over the canonical JSON of `result` (WebCrypto, hex). */
export async function sha256Hex(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Impose the receipt construction key order (sources, synthesis, keyFindings,
 * confidence — the order buildReceipt/research.ts hash over) onto a persisted
 * result object WITHOUT copying or altering values. Convex storage normalizes
 * object key order on read-back (alphabetically), so the persisted object can
 * never re-stringify to the original hash bytes; re-imposing the fixed
 * construction order over the SAME persisted values is the only faithful
 * reproduction. Values are passed through by reference — nothing is rebuilt.
 */
export function canonicalReceiptResult(result: unknown): unknown {
  if (
    typeof result === "object" &&
    result !== null &&
    "sources" in result &&
    "synthesis" in result &&
    "keyFindings" in result &&
    "confidence" in result
  ) {
    const r = result as Record<string, unknown>;
    return {
      sources: r.sources,
      synthesis: r.synthesis,
      keyFindings: r.keyFindings,
      confidence: r.confidence,
    };
  }
  return result;
}

/**
 * Attach the verified resultHash to a proof payload. Returns null when the
 * recomputed SHA-256(JSON.stringify(result)) does NOT equal the persisted
 * hash — the proof is never served with an unverified integrity chain.
 * `result` must already be in canonical construction order (see
 * canonicalReceiptResult) so what is served is exactly what was hashed.
 */
export async function attachVerifiedResultHash(
  proof: PublicProof,
  persistedResultHash: string,
): Promise<PublicProof | null> {
  const recomputed = await sha256Hex(proof.result);
  const expected = persistedResultHash.replace(/^sha256:/, "");
  if (recomputed !== expected) return null;
  return { ...proof, resultHash: persistedResultHash };
}

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
 * Extract the order id from a /api/proof/:orderId pathname. Returns null for
 * malformed paths (no segment, or extra segments) — the endpoint answers 404.
 */
export function orderIdFromProofPath(pathname: string): string | null {
  const m = pathname.match(/^\/api\/proof\/([^/]+?)$/);
  return m?.[1] ?? null;
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

// ---------------------------------------------------------------------------
// Per-order amount validation (variable pricing, 1 USDC minimum).
//
// POST /api/orders accepts an optional `amount`: the EXACT price for that
// order, denominated in USDC. Rules mirror the documented Moove payment-link
// contract: string decimals only (avoid float rounding), at most 6 decimal
// places (USDC precision, else Moove 422 INVALID_PAYMENT_LINK_AMOUNT), and
// value >= the service minimum (1 USDC). The exact string is preserved
// through order and receipt — never normalized ("2.50" stays "2.50").
// ---------------------------------------------------------------------------

const AMOUNT_RE = /^\d+(\.\d{1,6})?$/;

/**
 * Validate an optional per-order amount. `undefined` yields the service
 * minimum (the documented default). Returns the EXACT input string on
 * success — no normalization, no float math.
 */
export function validateOrderAmount(
  input: unknown,
): { ok: true; amount: string } | { ok: false; error: string } {
  if (input === undefined) {
    return { ok: true, amount: RESEARCH_SERVICE.payment.minimumAmount };
  }
  if (typeof input !== "string") {
    return {
      ok: false,
      error:
        'amount must be a string decimal in USDC, e.g. "1.50" (numbers are rejected to avoid float rounding)',
    };
  }
  if (!AMOUNT_RE.test(input)) {
    return {
      ok: false,
      error: 'amount must be a decimal string with at most 6 decimal places, e.g. "1.50"',
    };
  }
  // Decimal-safe minimum check (no float arithmetic): value >= 1 iff the
  // integer part, with leading zeros stripped, represents a number >= 1.
  const intPart = input.split(".")[0] ?? "0";
  const significant = intPart.replace(/^0+(?=\d)/, "");
  if (significant === "0") {
    return {
      ok: false,
      error: `amount must be at least ${RESEARCH_SERVICE.payment.minimumAmount} USDC`,
    };
  }
  return { ok: true, amount: input };
}

/**
 * Payment gate helper: an order's persisted amount is payable iff it is a
 * valid per-order amount (>= the 1 USDC minimum, <= 6 decimals). Replaces
 * the old exact-equality check so legitimate amounts ABOVE the minimum pass.
 */
export function isValidResearchAmount(amount: string): boolean {
  return validateOrderAmount(amount).ok;
}

/** Validate the machine order request body for POST /api/orders. */
export function validateOrderRequest(body: {
  query?: unknown;
  amount?: unknown;
}): { ok: true; query: string; amount: string } | { ok: false; error: string } {
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
  // Optional exact per-order amount; omitted -> the 1 USDC minimum.
  const amount = validateOrderAmount(body.amount);
  if (!amount.ok) return amount;
  return { ok: true, query: q, amount: amount.amount };
}

// ---------------------------------------------------------------------------
// Discovery index (GET /api/services).
// Presentation-only: `price` communicates the FROM/minimum form for humans
// and agents; the structured `pricing` object carries the machine-readable
// facts (exact decimal-string minimum plus a numeric convenience field).
// Validation authority remains validateOrderAmount — this payload never
// feeds payment logic.
// ---------------------------------------------------------------------------

/** Shape of the GET /api/services discovery payload. */
export interface DiscoveryPayload {
  protocol: string;
  services: Array<{
    id: string;
    name: string;
    version: string;
    price: string;
    pricing: {
      model: string;
      currency: string;
      /** Exact decimal string — canonical, no float loss. */
      minimumAmount: string;
      /** Numeric convenience for agents; the minimum is a whole number. */
      minimumAmountValue: number;
      /** Applied by POST /api/orders when the caller omits `amount`. */
      defaultAmount: string;
      /** The payer cannot edit the amount on the hosted checkout. */
      payerEditable: boolean;
    };
    contractUrl: string;
  }>;
}

/** Build the GET /api/services discovery payload. */
export function buildDiscoveryPayload(): DiscoveryPayload {
  return {
    protocol: RESEARCH_SERVICE.protocol,
    services: [
      {
        id: RESEARCH_SERVICE.id,
        name: RESEARCH_SERVICE.name,
        version: RESEARCH_SERVICE.version,
        price: `from ${RESEARCH_SERVICE.payment.minimumAmount} ${RESEARCH_SERVICE.payment.currency}`,
        pricing: {
          model: "per_order_exact_amount",
          currency: RESEARCH_SERVICE.payment.currency,
          minimumAmount: RESEARCH_SERVICE.payment.minimumAmount,
          minimumAmountValue: Number(RESEARCH_SERVICE.payment.minimumAmount),
          defaultAmount: RESEARCH_SERVICE.payment.amount,
          payerEditable: false,
        },
        contractUrl: `/api/services/${RESEARCH_SERVICE.id}/contract`,
      },
    ],
  };
}
