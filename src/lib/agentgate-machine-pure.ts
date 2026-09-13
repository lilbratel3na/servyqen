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
