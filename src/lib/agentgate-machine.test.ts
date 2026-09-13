import { describe, expect, it } from "vitest";

import {
  canTransition,
} from "./agentgate-contract";
import {
  constantTimeHexEqual,
  generateOrderToken,
  hashToken,
  isHex64,
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
