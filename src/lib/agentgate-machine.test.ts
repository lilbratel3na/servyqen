import { describe, expect, it, vi } from "vitest";

import {
  ALLOWED_TRANSITIONS,
  canTransition,
  RESEARCH_SERVICE,
} from "./agentgate-contract";
import {
  attachVerifiedResultHash,
  buildDiscoveryPayload,
  buildPublicProof,
  canonicalReceiptResult,
  constantTimeHexEqual,
  evaluateExecutionClaim,
  evaluateFailureRecovery,
  generateOrderToken,
  hashToken,
  isHex64,
  isTransientExecutionError,
  isValidResearchAmount,
  orderIdFromProofPath,
  PROOF_FIELDS,
  randomToken,
  sha256Hex,
  validateOrderAmount,
  validateOrderRequest,
} from "./agentgate-machine-pure";

describe("POST /api/orders request validation", () => {
  it("accepts a valid query and trims surrounding whitespace", () => {
    const ok = validateOrderRequest({ query: "  scaling laws for LLMs  " });
    expect(ok).toEqual({ ok: true, query: "scaling laws for LLMs", amount: "1" });
  });

  it("defaults amount to the contract minimum when omitted", () => {
    expect(validateOrderRequest({ query: "12345678" })).toEqual({
      ok: true,
      query: "12345678",
      amount: RESEARCH_SERVICE.payment.minimumAmount,
    });
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

  it("rejects an invalid amount even when the query is valid", () => {
    expect(validateOrderRequest({ query: "12345678", amount: "0.5" }).ok).toBe(false);
    expect(validateOrderRequest({ query: "12345678", amount: "abc" }).ok).toBe(false);
    expect(validateOrderRequest({ query: "12345678", amount: 1.5 }).ok).toBe(false);
  });

  it("accepts and preserves a valid custom amount exactly", () => {
    const ok = validateOrderRequest({ query: "12345678", amount: "2.50" });
    expect(ok).toEqual({ ok: true, query: "12345678", amount: "2.50" });
  });
});

// ---------------------------------------------------------------------------
// Per-order variable pricing (1 USDC minimum, USDC 6-decimal precision).
// ---------------------------------------------------------------------------

describe("per-order amount validation (variable pricing)", () => {
  it("omitted amount defaults to the 1 USDC minimum", () => {
    expect(validateOrderAmount(undefined)).toEqual({ ok: true, amount: "1" });
  });

  it("accepts the exact minimum", () => {
    expect(validateOrderAmount("1")).toEqual({ ok: true, amount: "1" });
  });

  it("accepts 1.5 and preserves the exact string", () => {
    expect(validateOrderAmount("1.5")).toEqual({ ok: true, amount: "1.5" });
  });

  it("accepts 2.50 without normalizing it", () => {
    expect(validateOrderAmount("2.50")).toEqual({ ok: true, amount: "2.50" });
  });

  it("accepts 1.000001 — exactly 6 decimals (USDC precision)", () => {
    expect(validateOrderAmount("1.000001")).toEqual({ ok: true, amount: "1.000001" });
  });

  it("rejects amounts below the 1 USDC minimum, including decimal-only values", () => {
    expect(validateOrderAmount("0.5").ok).toBe(false);
    expect(validateOrderAmount("0.999999").ok).toBe(false);
    expect(validateOrderAmount("0.000001").ok).toBe(false);
    expect(validateOrderAmount("0").ok).toBe(false);
    expect(validateOrderAmount("00").ok).toBe(false);
  });

  it("rejects malformed decimals", () => {
    expect(validateOrderAmount("").ok).toBe(false);
    expect(validateOrderAmount("1.").ok).toBe(false);
    expect(validateOrderAmount(".5").ok).toBe(false);
    expect(validateOrderAmount("1.5.5").ok).toBe(false);
    expect(validateOrderAmount("1,50").ok).toBe(false);
    expect(validateOrderAmount("1 50").ok).toBe(false);
    expect(validateOrderAmount("-1").ok).toBe(false);
    expect(validateOrderAmount("1e3").ok).toBe(false);
    expect(validateOrderAmount(" 1 ").ok).toBe(false); // no trimming: exact string only
    expect(validateOrderAmount("abc").ok).toBe(false);
  });

  it("rejects excessive precision (7+ decimals would 422 at Moove)", () => {
    expect(validateOrderAmount("1.0000001").ok).toBe(false);
    expect(validateOrderAmount("10.1234567").ok).toBe(false);
  });

  it("rejects non-string amounts (numbers are refused to avoid float rounding)", () => {
    expect(validateOrderAmount(1).ok).toBe(false);
    expect(validateOrderAmount(1.5).ok).toBe(false);
    expect(validateOrderAmount(null).ok).toBe(false);
    expect(validateOrderAmount({ amount: "1" }).ok).toBe(false);
  });

  it("accepts whole-number amounts above the minimum", () => {
    expect(validateOrderAmount("2")).toEqual({ ok: true, amount: "2" });
    expect(validateOrderAmount("100")).toEqual({ ok: true, amount: "100" });
  });

  it("accepts values with leading integer zeros only when >= 1", () => {
    expect(validateOrderAmount("01")).toEqual({ ok: true, amount: "01" });
    expect(validateOrderAmount("01.5")).toEqual({ ok: true, amount: "01.5" });
  });
});

describe("research payment gate accepts legitimate amounts above the minimum", () => {
  it("the persisted order amount must be a valid per-order price", () => {
    expect(isValidResearchAmount("1")).toBe(true);
    expect(isValidResearchAmount("1.5")).toBe(true);
    expect(isValidResearchAmount("2.50")).toBe(true);
    expect(isValidResearchAmount("12")).toBe(true);
  });

  it("the gate still refuses below-minimum or malformed persisted amounts", () => {
    expect(isValidResearchAmount("0.5")).toBe(false);
    expect(isValidResearchAmount("0")).toBe(false);
    expect(isValidResearchAmount("")).toBe(false);
    expect(isValidResearchAmount("1.0000001")).toBe(false);
    expect(isValidResearchAmount("free")).toBe(false);
  });

  it("the contract advertises per-order pricing with a payer-editable checkout explicitly excluded", () => {
    expect(RESEARCH_SERVICE.payment.minimumAmount).toBe("1");
    expect(RESEARCH_SERVICE.payment.pricingModel).toContain("per_order_exact_amount");
    expect(RESEARCH_SERVICE.payment.pricingModel).toContain("CANNOT edit");
    expect(RESEARCH_SERVICE.endpoints.initiate).toContain("amount?");
    expect(RESEARCH_SERVICE.endpoints.initiate).toContain("payer cannot edit");
  });
});

// ---------------------------------------------------------------------------
// Successful >1 order path: the REAL initiateOrder handler is exercised with
// a mocked fetch (standing in for the Moove API) and a mocked Convex ctx, so
// the full HTTP->validation->link-creation chain is covered without any real
// network call or payment.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GET /api/services discovery: public price presentation communicates the
// from/minimum form while keeping machine-readable pricing facts.
// ---------------------------------------------------------------------------

describe("GET /api/services discovery payload", () => {
  const svc = buildDiscoveryPayload().services[0]!;

  it("presents the public price in from/minimum form", () => {
    expect(svc.price).toBe("from 1 USDC");
    expect(svc.price).not.toMatch(/^1 USDC$/);
  });

  it("exposes the exact machine-readable minimum as a decimal string", () => {
    expect(svc.pricing.minimumAmount).toBe("1");
    expect(typeof svc.pricing.minimumAmount).toBe("string");
  });

  it("exposes a numeric minimum convenience field for agents", () => {
    expect(svc.pricing.minimumAmountValue).toBe(1);
    expect(typeof svc.pricing.minimumAmountValue).toBe("number");
  });

  it("states the pricing model, currency, default, and non-editable payer amount", () => {
    expect(svc.pricing.model).toBe("per_order_exact_amount");
    expect(svc.pricing.currency).toBe("USDC");
    expect(svc.pricing.defaultAmount).toBe("1");
    expect(svc.pricing.payerEditable).toBe(false);
  });

  it("still points at the full contract for details", () => {
    expect(svc.contractUrl).toBe("/api/services/ai-research-v1/contract");
  });

  it("is consistent with the validation minimum", () => {
    // The advertised minimum and the enforced minimum are the same fact.
    expect(svc.pricing.minimumAmount).toBe(RESEARCH_SERVICE.payment.minimumAmount);
    expect(validateOrderAmount(svc.pricing.minimumAmount)).toEqual({
      ok: true,
      amount: svc.pricing.minimumAmount,
    });
  });
});

describe("initiateOrder passes the exact >1 amount to Moove (mocked)", () => {
  // Placeholder credential for the handler's config guard. fetch is stubbed,
  // so this value never leaves the test process and is not a real secret.
  process.env.MOOVE_API_KEY = "test-placeholder-key";

  it("creates the payment link with toAmount exactly as requested", async () => {
    const { initiateOrder } = await import("../convex/moove");
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "link-123", url: "https://moove.xyz/@h/pay/link-123" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const runMutation = vi.fn(async () => "order-abc" as never);
      const ctx = { runMutation } as never;

      // Convex function wrappers expose the raw handler as `_handler`.
      const { orderId } = await (initiateOrder as any)._handler(ctx, {
        userId: undefined,
        query: "transformer scaling laws",
        amount: "2.50",
      } as never);

      expect(orderId).toBe("order-abc");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://api.moove.xyz/v1/payment-link");
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      // The EXACT requested amount reaches Moove — not the default, not a float.
      expect(body["toAmount"]).toBe("2.50");
      expect(body["maxUsage"]).toBe(1);
      // The order persists the exact amount alongside the real link.
      const persistCall = runMutation.mock.calls[0] as unknown as [
        unknown,
        Record<string, unknown>,
      ];
      expect(persistCall[1]["amount"]).toBe("2.50");
      expect(persistCall[1]["paymentLinkId"]).toBe("link-123");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("omitted amount defaults the link to the 1 USDC minimum", async () => {
    const { initiateOrder } = await import("../convex/moove");
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "link-456", url: "https://moove.xyz/@h/pay/link-456" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const runMutation = vi.fn(async () => "order-def" as never);
      await (initiateOrder as any)._handler({ runMutation } as never, {
        userId: undefined,
        query: "transformer scaling laws",
      } as never);
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.parse(String(init.body))["toAmount"]).toBe(
        RESEARCH_SERVICE.payment.minimumAmount,
      );
    } finally {
      vi.unstubAllGlobals();
    }
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

// ---------------------------------------------------------------------------
// GET /api/proof/:orderId — public proof surface.
// The order id is an OPAQUE PUBLIC PROOF IDENTIFIER (not a capability);
// security comes from the endpoint being read-only and this strict
// allowlist projection, which is what these tests pin down.
// ---------------------------------------------------------------------------

describe("GET /api/proof/:orderId — path extraction", () => {
  it("extracts the order id from a well-formed proof path", () => {
    expect(orderIdFromProofPath("/api/proof/k174abc123")).toBe("k174abc123");
  });

  it("returns null for malformed paths (no id, extra segments, wrong prefix)", () => {
    expect(orderIdFromProofPath("/api/proof/")).toBeNull();
    expect(orderIdFromProofPath("/api/proof/a/b")).toBeNull();
    expect(orderIdFromProofPath("/api/orders/k174abc123")).toBeNull();
    expect(orderIdFromProofPath("/api/proofs/k174abc123")).toBeNull();
    expect(orderIdFromProofPath("/api/proof/k174abc123/run")).toBeNull();
  });
});

describe("GET /api/proof/:orderId — allowlist projection", () => {
  const sampleResult = {
    sources: [
      {
        title: "Attention Is All You Need",
        authors: ["A. Author"],
        published: "2017-06-12",
        absUrl: "https://arxiv.org/abs/1706.03762",
        pdfUrl: "https://arxiv.org/pdf/1706.03762",
        summary: "We propose the transformer architecture.",
      },
    ],
    synthesis: "Extractive synthesis for “test query”.",
    keyFindings: ["[Attention Is All You Need] We propose..."],
    confidence: 1,
  };

  const sampleInput = {
    orderId: "k17431b32f1mqk41b3h0w38whh8ebbrm",
    serviceId: "ai-research-v1",
    amount: "1",
    currency: "USDC",
    paymentLinkId: "3edba4fa-02e3-48ac-862d-6a236a40e2b7",
    paymentStatus: "completed",
    transactionUrl: "https://polygonscan.com/tx/0xabc",
    executionStatus: "completed",
    executionAttempts: 1,
    executedMs: 4213,
    query: "attention mechanisms for sparse transformers",
    result: sampleResult as unknown,
  };

  it("exposes exactly the approved top-level fields — no more, no fewer", () => {
    const proof = buildPublicProof(sampleInput);
    expect(Object.keys(proof).sort()).toEqual([...PROOF_FIELDS].sort());
  });

  it("carries evidence fields through unchanged", () => {
    const proof = buildPublicProof(sampleInput);
    expect(proof.orderId).toBe(sampleInput.orderId);
    expect(proof.serviceId).toBe("ai-research-v1");
    expect(proof.amount).toBe("1");
    expect(proof.currency).toBe("USDC");
    expect(proof.paymentLinkId).toBe("3edba4fa-02e3-48ac-862d-6a236a40e2b7");
    expect(proof.paymentStatus).toBe("completed");
    expect(proof.transactionUrl).toBe("https://polygonscan.com/tx/0xabc");
    expect(proof.executionStatus).toBe("completed");
    expect(proof.executionAttempts).toBe(1);
    expect(proof.executedMs).toBe(4213);
    expect(proof.query).toBe(sampleInput.query);
    expect(proof.result).toBe(sampleResult);
  });

  it("fills SLA target and note from the contract", () => {
    const proof = buildPublicProof(sampleInput);
    expect(proof.slaTargetMs).toBe(RESEARCH_SERVICE.execution.slaTargetMs);
    expect(proof.slaNote).toBe(RESEARCH_SERVICE.execution.slaNote);
  });

  it("NEVER exposes capability tokens, token hashes, user identity, checkout URL, error or failure details", () => {
    // The projection's signature only accepts allowlisted inputs; sensitive
    // fields smuggled into the input object must be structurally dropped.
    const proof = buildPublicProof({
      ...sampleInput,
      orderTokenHash: "a".repeat(64),
      capabilityToken: "b".repeat(64),
      userId: "user_leak_123",
      moovePaymentUrl: "https://pay.moove.xyz/checkout-leak",
      error: "internal_error_details",
      failureKind: "transient",
      mooveLinkStatus: "completed",
    } as typeof sampleInput & Record<string, unknown>);
    const serialized = JSON.stringify(proof);
    // Sentinel VALUES planted above must not survive anywhere in the proof.
    for (const banned of [
      "a".repeat(64),
      "b".repeat(64),
      "user_leak_123",
      "checkout-leak",
      "internal_error_details",
      // And none of the banned field NAMES may appear as keys.
      '"orderTokenHash"',
      '"capabilityToken"',
      '"moovePaymentUrl"',
      '"paymentUrl"',
      '"userId"',
      '"email"',
      '"error"',
      '"failureKind"',
      '"mooveLinkStatus"',
    ]) {
      expect(serialized.includes(banned)).toBe(false);
    }
    // Only the allowlisted keys exist at the top level.
    for (const key of Object.keys(proof)) {
      expect(PROOF_FIELDS).toContain(key);
    }
  });

  it("falls back to paymentStatus 'unknown' when no Moove status is persisted", () => {
    const proof = buildPublicProof({ ...sampleInput, paymentStatus: null });
    expect(proof.paymentStatus).toBe("unknown");
  });

  it("attaches the persisted resultHash only when the recomputed hash matches", async () => {
    const proof = buildPublicProof(sampleInput);
    const canonicalHash = await sha256Hex(sampleResult);
    const persisted = `sha256:${canonicalHash}`;

    const verified = await attachVerifiedResultHash(proof, persisted);
    expect(verified).not.toBeNull();
    expect(verified!.resultHash).toBe(persisted);

    // Tampered result → the proof must NOT be produced.
    const tampered = await attachVerifiedResultHash(
      proof,
      "sha256:" + "0".repeat(64),
    );
    expect(tampered).toBeNull();
  });

  it("verifies the full chain end-to-end: receipt result hash round-trips", async () => {
    // Simulate the persisted receipt built by buildReceipt at completion:
    // the proof must re-verify SHA-256(JSON.stringify(result)) against it.
    const receiptResult = sampleResult;
    const resultHash = `sha256:${await sha256Hex(receiptResult)}`;
    const proof = buildPublicProof({ ...sampleInput, result: receiptResult });
    const verified = await attachVerifiedResultHash(proof, resultHash);
    expect(verified).not.toBeNull();
    expect(verified!.resultHash).toBe(resultHash);
  });
});

describe("GET /api/proof/:orderId — canonical result serialization", () => {
  const constructionOrder = {
    sources: [{ title: "T", authors: ["A"], published: "2026-01-01", absUrl: "https://arxiv.org/abs/1", pdfUrl: "https://arxiv.org/pdf/1", summary: "S" }],
    synthesis: "synthesis text",
    keyFindings: ["finding one"],
    confidence: 0.8,
  };

  it("re-imposes the receipt construction key order without copying values", () => {
    // Convex read-back shape: keys alphabetized by storage.
    const persisted = {
      confidence: constructionOrder.confidence,
      keyFindings: constructionOrder.keyFindings,
      sources: constructionOrder.sources,
      synthesis: constructionOrder.synthesis,
    };
    const canonical = canonicalReceiptResult(persisted) as Record<string, unknown>;
    expect(Object.keys(canonical)).toEqual([
      "sources",
      "synthesis",
      "keyFindings",
      "confidence",
    ]);
    // Values pass through by reference — nothing is rebuilt.
    expect(canonical.sources).toBe(persisted.sources);
    expect(canonical.synthesis).toBe(persisted.synthesis);
    expect(canonical.keyFindings).toBe(persisted.keyFindings);
    expect(canonical.confidence).toBe(persisted.confidence);
  });

  it("makes a storage-normalized object hash identically to the construction-order original", async () => {
    const persisted = {
      confidence: constructionOrder.confidence,
      keyFindings: constructionOrder.keyFindings,
      sources: constructionOrder.sources,
      synthesis: constructionOrder.synthesis,
    };
    const constructionHash = await sha256Hex(constructionOrder);
    const persistedHash = await sha256Hex(persisted);
    // Storage normalization genuinely breaks plain re-stringification...
    expect(persistedHash).not.toBe(constructionHash);
    // ...and canonicalization restores it over the SAME values.
    const canonicalHash = await sha256Hex(canonicalReceiptResult(persisted));
    expect(canonicalHash).toBe(constructionHash);
  });

  it("passes through objects without the four receipt fields unchanged", () => {
    const odd = { foo: 1, bar: [2, 3] };
    expect(canonicalReceiptResult(odd)).toBe(odd);
    expect(canonicalReceiptResult(null)).toBeNull();
    expect(canonicalReceiptResult("text")).toBe("text");
  });

  it("endpoint pipeline: normalized persisted receipt verifies against the completion-time hash", async () => {
    // research.ts hashed the result in construction order at completion.
    const constructionHash = await sha256Hex(constructionOrder);
    const persistedHash = `sha256:${constructionHash}`;
    // ...but storage returns it alphabetized. The endpoint canonicalizes
    // before hashing/serving, so verification succeeds.
    const persisted = {
      confidence: constructionOrder.confidence,
      keyFindings: constructionOrder.keyFindings,
      sources: constructionOrder.sources,
      synthesis: constructionOrder.synthesis,
    };
    const proof = buildPublicProof({
      orderId: "k17431b32f1mqk41b3h0w38whh8ebbrm",
      serviceId: "ai-research-v1",
      amount: "1",
      currency: "USDC",
      paymentLinkId: "3edba4fa-02e3-48ac-862d-6a236a40e2b7",
      paymentStatus: "completed",
      transactionUrl: "https://polygonscan.com/tx/0xabc",
      executionStatus: "completed",
      executionAttempts: 1,
      executedMs: 4213,
      query: "attention mechanisms for sparse transformers",
      result: canonicalReceiptResult(persisted),
    });
    const verified = await attachVerifiedResultHash(proof, persistedHash);
    expect(verified).not.toBeNull();
    expect(verified!.resultHash).toBe(persistedHash);
  });
});
