import { describe, expect, it } from "vitest";

import {
  ALLOWED_TRANSITIONS,
  canTransition,
} from "./agentgate-contract";
import {
  constantTimeHexEqual,
  evaluateExecutionClaim,
  evaluateFailureRecovery,
  generateOrderToken,
  hashToken,
  isHex64,
  isTransientExecutionError,
  randomToken,
  validateOrderRequest,
} from "./agentgate-machine-pure";

describe("POST /api/orders request validation", () => {
  it("accepts a valid query and trims surrounding whitespace", () => {
    const ok = validateOrderRequest({ query: "  scaling laws for LLMs  " });
    expect(ok).toEqual({ ok: true, query: "scaling laws for LLMs" });
  });

  it("rejects non-object bodies (null, arrays, primitives)", () => {
    expect(validateOrderRequest(null as never).ok).toBe(false);
    expect(validateOrderRequest([1, 2] as never).ok).toBe(false);
    expect(validateOrderRequest("query" as never).ok).toBe(false);
    expect(validateOrderRequest(undefined as never).ok).toBe(false);
  });

  it("rejects a missing or non-string query", () => {
    expect(validateOrderRequest({}).ok).toBe(false);
    expect(validateOrderRequest({ query: 42 as never }).ok).toBe(false);
  });

  it("rejects queries shorter than 8 characters after trimming", () => {
    expect(validateOrderRequest({ query: "short" }).ok).toBe(false);
    // Exactly 8 after trimming is valid.
    expect(validateOrderRequest({ query: "12345678" }).ok).toBe(true);
  });

  it("rejects queries longer than 512 characters", () => {
    expect(validateOrderRequest({ query: "q".repeat(513) }).ok).toBe(false);
    expect(validateOrderRequest({ query: "q".repeat(512) }).ok).toBe(true);
  });
});

describe("capability token design", () => {
  it("generates a 64-char lowercase-hex token and a distinct hash", async () => {
    const { token, tokenHash } = await generateOrderToken();
    expect(isHex64(token)).toBe(true);
    expect(isHex64(tokenHash)).toBe(true);
    expect(token).not.toBe(tokenHash);
  });

  it("stores only the hash of the raw token", async () => {
    const { token, tokenHash } = await generateOrderToken();
    expect(tokenHash).toBe(await hashToken(token));
  });

  it("is unguessable: successive generations differ", async () => {
    const a = await generateOrderToken();
    const b = await generateOrderToken();
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });

  it("randomToken always yields 256 bits of hex", () => {
    for (let i = 0; i < 10; i++) expect(isHex64(randomToken())).toBe(true);
  });
});

describe("capability verification (authorization)", () => {
  it("accepts the correct token and rejects a wrong token", async () => {
    const { token, tokenHash } = await generateOrderToken();

    const good = await hashToken(token);
    expect(constantTimeHexEqual(tokenHash, good)).toBe(true);

    const bad = await hashToken("wrong-token");
    expect(constantTimeHexEqual(tokenHash, bad)).toBe(false);
  });

  it("rejects a missing capability outright", async () => {
    const { tokenHash } = await generateOrderToken();
    expect(constantTimeHexEqual(tokenHash, "")).toBe(false);
  });

  it("rejects malformed tokens before comparison", () => {
    expect(isHex64("not-hex-at-all")).toBe(false);
    expect(isHex64("ABCDEFabcdef")).toBe(false); // wrong length AND uppercase
    expect(isHex64("g".repeat(64))).toBe(false); // non-hex character
    expect(isHex64("a".repeat(63))).toBe(false); // 255 bits — wrong length
    expect(constantTimeHexEqual("zz", "zz")).toBe(false);
  });

  it("hashing is deterministic for identical inputs", async () => {
    expect(await hashToken("same")).toBe(await hashToken("same"));
  });
});

describe("machine API cannot bypass the payment gate", () => {
  it("no machine route can walk an unpaid order into execution or completion", () => {
    // The claim gate (orders.claimExecutingInternal) only accepts orders in
    // payment_confirmed; the state machine must refuse everything else.
    expect(canTransition("awaiting_payment", "executing")).toBe(false);
    expect(canTransition("awaiting_payment", "completed")).toBe(false);
    expect(canTransition("expired", "executing")).toBe(false);
    expect(canTransition("expired", "completed")).toBe(false);
  });

  it("execution cannot re-confirm payment or restart after completion", () => {
    expect(canTransition("executing", "payment_confirmed")).toBe(false);
    expect(canTransition("completed", "executing")).toBe(false);
    expect(canTransition("completed", "payment_confirmed")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Paid-order transient-failure retry (failed_retriable) — the payment gate,
// one-shot claim, and evidence preservation rules that the retry path rides.
// ---------------------------------------------------------------------------

describe("execution failure classification", () => {
  it("classifies transient infrastructure failures as retriable", () => {
    // The exact error from the live failed order (arXiv fetch aborted by its
    // own 15s AbortController).
    expect(isTransientExecutionError("This operation was aborted")).toBe(true);
    expect(isTransientExecutionError("arXiv API request timeout")).toBe(true);
    expect(isTransientExecutionError("request timed out after 15000ms")).toBe(true);
    expect(isTransientExecutionError("fetch failed")).toBe(true);
    expect(isTransientExecutionError("getaddrinfo ENOTFOUND export.arxiv.org")).toBe(true);
    expect(isTransientExecutionError("connect ECONNREFUSED 127.0.0.1:443")).toBe(true);
    expect(isTransientExecutionError("network error while fetching")).toBe(true);
    expect(isTransientExecutionError("arXiv API returned HTTP 503")).toBe(true);
    expect(isTransientExecutionError("arXiv API returned HTTP 429")).toBe(true);
    expect(isTransientExecutionError("arXiv temporarily unavailable")).toBe(true);
  });

  it("classifies permanent contract/integrity failures as terminal", () => {
    expect(
      isTransientExecutionError(
        "arXiv returned only 2 verifiable sources for this query; the service requires 5 real sources and will not fabricate the remainder.",
      ),
    ).toBe(false);
    expect(
      isTransientExecutionError("amount_mismatch: order does not match contract price"),
    ).toBe(false);
    expect(isTransientExecutionError("postcondition_violation: sources != 5")).toBe(false);
    expect(isTransientExecutionError("receipt_source_data_missing")).toBe(false);
    expect(isTransientExecutionError("order_not_found")).toBe(false);
    expect(isTransientExecutionError("arXiv API returned HTTP 400")).toBe(false);
    // Unknown errors default to permanent — the classifier is conservative.
    expect(isTransientExecutionError("something completely unknown")).toBe(false);
    expect(isTransientExecutionError("")).toBe(false);
  });
});

describe("paid order retries after transient execution failure", () => {
  const paidRetriable = {
    status: "failed_retriable",
    paymentConfirmedAt: 1789336752495,
  };

  it("failed_retriable -> executing is a legal transition", () => {
    expect(canTransition("failed_retriable", "executing")).toBe(true);
  });

  it("a paid failed_retriable order passes the execution claim gate", () => {
    expect(evaluateExecutionClaim(paidRetriable, 180_000)).toEqual({ ok: true });
  });

  it("a retry does not re-confirm payment: no edge back to payment_confirmed", () => {
    expect(canTransition("failed_retriable", "payment_confirmed")).toBe(false);
    // The retry re-verifies payment via Moove's status endpoint, but the
    // original paymentConfirmedAt evidence is never rewritten.
    expect(ALLOWED_TRANSITIONS.failed_retriable).toEqual(["executing"]);
  });

  it("a successful retry completes through the normal transition", () => {
    expect(canTransition("failed_retriable", "executing")).toBe(true);
    expect(canTransition("executing", "completed")).toBe(true);
  });

  it("a failed retry is again retriable without paying again", () => {
    expect(canTransition("executing", "failed_retriable")).toBe(true);
  });
});

describe("unpaid orders cannot use the retry path", () => {
  it("an unpaid failed_retriable order is refused by the claim gate", () => {
    // Even if status somehow read failed_retriable, no persisted payment
    // confirmation evidence means no execution — the hard payment gate.
    expect(
      evaluateExecutionClaim({ status: "failed_retriable" }, 180_000),
    ).toEqual({ ok: false, reason: "not_paid" });
  });

  it("an unpaid order in any state is refused by the claim gate", () => {
    for (const status of [
      "awaiting_payment",
      "payment_confirmed",
      "executing",
      "completed",
      "failed",
      "failed_retriable",
      "expired",
    ]) {
      expect(evaluateExecutionClaim({ status }, 180_000)).toEqual({
        ok: false,
        reason: "not_paid",
      });
    }
  });

  it("awaiting_payment cannot transition to failed_retriable (no unpaid retry state)", () => {
    expect(canTransition("awaiting_payment", "failed_retriable")).toBe(false);
    expect(canTransition("expired", "failed_retriable")).toBe(false);
  });

  it("legacy recovery refuses orders without payment evidence", () => {
    expect(
      evaluateFailureRecovery({
        status: "failed",
        error: "This operation was aborted",
      }),
    ).toEqual({ ok: false, reason: "not_paid" });
  });
});

describe("retry cannot create a second Moove payment link", () => {
  it("failed_retriable has no transition that reaches a payment-link path", () => {
    // Payment-link creation lives exclusively in moove.initiateOrder, which
    // is only invoked from the two order-creation entry points on a fresh
    // awaiting_payment order. The retry path's only outgoing edge is
    // failed_retriable -> executing (the existing one-shot claim).
    expect(ALLOWED_TRANSITIONS.failed_retriable).toEqual(["executing"]);
    // No transition returns an order to a fresh-creation state.
    expect(canTransition("failed_retriable", "awaiting_payment")).toBe(false);
    expect(canTransition("failed", "awaiting_payment")).toBe(false);
  });
});

describe("concurrent retries cannot execute the service twice", () => {
  it("a fresh claim transitions to executing; a second concurrent claim sees executing and is refused", () => {
    const staleClaimMs = 180_000;
    // First claimant: paid failed_retriable order -> ok.
    expect(
      evaluateExecutionClaim(
        { status: "failed_retriable", paymentConfirmedAt: 1789336752495 },
        staleClaimMs,
      ),
    ).toEqual({ ok: true });
    // Second concurrent claimant reads the order AFTER the first patch:
    // status executing, started moments ago (within stale window).
    expect(
      evaluateExecutionClaim(
        {
          status: "executing",
          paymentConfirmedAt: 1789336752495,
          executionStartedAt: Date.now() - 1000,
        },
        staleClaimMs,
      ),
    ).toEqual({ ok: false, reason: "already_executing" });
  });

  it("a stale claim (crashed run) remains reclaimable after the stale window", () => {
    expect(
      evaluateExecutionClaim(
        {
          status: "executing",
          paymentConfirmedAt: 1789336752495,
          executionStartedAt: Date.now() - 10 * 60_000,
        },
        180_000,
      ),
    ).toEqual({ ok: true });
  });
});

describe("failed retry leaves the order safely retriable", () => {
  it("executing -> failed_retriable is legal, so a failed retry re-enters the claimable set", () => {
    expect(canTransition("executing", "failed_retriable")).toBe(true);
    // And from failed_retriable the paid order can claim again.
    expect(
      evaluateExecutionClaim(
        { status: "failed_retriable", paymentConfirmedAt: 1789336752495 },
        180_000,
      ),
    ).toEqual({ ok: true });
  });
});

describe("legacy terminal-failure recovery (pre-retry orders)", () => {
  const paidFailure = {
    status: "failed",
    paymentConfirmedAt: 1789336752495,
    error: "This operation was aborted",
  };

  it("recovers a PAID order whose recorded failure is transient", () => {
    expect(evaluateFailureRecovery(paidFailure)).toEqual({ ok: true });
    expect(canTransition("failed", "failed_retriable")).toBe(true);
  });

  it("refuses an UNPAID failed order even with a transient error", () => {
    expect(
      evaluateFailureRecovery({
        status: "failed",
        error: "This operation was aborted",
      }),
    ).toEqual({ ok: false, reason: "not_paid" });
  });

  it("refuses a paid order whose failure is PERMANENT", () => {
    expect(
      evaluateFailureRecovery({
        status: "failed",
        paymentConfirmedAt: 1789336752495,
        error: "postcondition_violation: sources != 5",
      }),
    ).toEqual({ ok: false, reason: "failure_not_transient" });
  });

  it("refuses orders not currently in failed", () => {
    expect(
      evaluateFailureRecovery({
        status: "failed_retriable",
        paymentConfirmedAt: 1789336752495,
        error: "This operation was aborted",
      }),
    ).toEqual({ ok: false, reason: "not_recoverable_from_failed_retriable" });
  });
});
