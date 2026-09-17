import { getAuthUserId } from "@convex-dev/auth/server";
import {
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import {
  canTransition,
  type OrderStatus,
} from "../lib/agentgate-contract";
import {
  constantTimeHexEqual,
  evaluateExecutionClaim,
  evaluateFailureRecovery,
  isHex64,
} from "../lib/agentgate-machine-pure";

/**
 * A mutation that moves an order through the guarded state machine.
 * Illegal transitions are rejected — never silently ignored — so a bug or an
 * attacker cannot walk an order into an undeserved state.
 */
type TransitionResult =
  | { ok: true; status: OrderStatus }
  | { ok: false; status: OrderStatus; reason: string };

/**
 * Internal: create a new order in awaiting_payment.
 */
export const createInternal = internalMutation({
  args: {
    userId: v.optional(v.id("users")),
    serviceId: v.string(),
    query: v.string(),
    amount: v.string(),
    currency: v.string(),
    paymentLinkId: v.string(),
    paymentUrl: v.string(),
    orderTokenHash: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"orders">> => {
    const now = Date.now();
    return await ctx.db.insert("orders", {
      userId: args.userId,
      serviceId: args.serviceId,
      query: args.query,
      amount: args.amount,
      currency: args.currency,
      status: "awaiting_payment",
      moovePaymentLinkId: args.paymentLinkId,
      moovePaymentUrl: args.paymentUrl,
      ...(args.orderTokenHash !== undefined
        ? { orderTokenHash: args.orderTokenHash }
        : {}),
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Internal: guarded status transition. The ONLY way any order status changes
 * in the entire application. All callers are server-side ("internal");
 * the frontend has no mutation that can reach this.
 */
export const transitionInternal = internalMutation({
  args: {
    orderId: v.id("orders"),
    to: v.string(),
    mooveLinkStatus: v.optional(v.string()),
    error: v.optional(v.string()),
    failureKind: v.optional(
      v.union(v.literal("transient"), v.literal("permanent")),
    ),
  },
  handler: async (ctx, args): Promise<TransitionResult> => {
    const order = await ctx.db.get(args.orderId);
    if (!order) return { ok: false, status: "failed", reason: "order_not_found" };

    const from = order.status as OrderStatus;
    const to = args.to as OrderStatus;
    if (!canTransition(from, to)) {
      return {
        ok: false,
        status: from,
        reason: `illegal_transition_${from}_to_${to}`,
      };
    }

    const now = Date.now();
    const patch: Record<string, unknown> = { status: to, updatedAt: now };
    if (to === "payment_confirmed") patch.paymentConfirmedAt = now;
    if (to === "executing") patch.executionStartedAt = now;
    if (to === "completed") patch.completedAt = now;
    if (args.mooveLinkStatus !== undefined) patch.mooveLinkStatus = args.mooveLinkStatus;
    if (args.error !== undefined) patch.error = args.error;
    if (args.failureKind !== undefined) patch.failureKind = args.failureKind;

    await ctx.db.patch(args.orderId, patch);
    return { ok: true, status: to };
  },
});

/**
 * Internal: ONE-SHOT claim of the right to execute. Transitions
 * payment_confirmed -> executing (fresh run) or failed_retriable -> executing
 * (paid retry) only when the pure gate decision allows it, so two concurrent
 * runs can never both pass the pre-execution gate (ctx.db.get/patch in a
 * mutation is serialized — the second claimant loses and sees ok: false).
 * A stale claim (crashed previous run) may be reclaimed.
 *
 * The gate decision (evaluateExecutionClaim) independently requires PERSISTED
 * payment confirmation evidence (paymentConfirmedAt) for EVERY claimable
 * state — this is the hard payment gate that makes the retry path unusable by
 * unpaid orders.
 */
export const claimExecutingInternal = internalMutation({
  args: {
    orderId: v.id("orders"),
    staleClaimMs: v.number(),
  },
  handler: async (ctx, args): Promise<TransitionResult> => {
    const order = await ctx.db.get(args.orderId);
    if (!order) return { ok: false, status: "failed", reason: "order_not_found" };

    // Pure, unit-tested gate: hard payment gate + one-shot claim semantics.
    const decision = evaluateExecutionClaim(
      {
        status: order.status,
        paymentConfirmedAt: order.paymentConfirmedAt,
        executionStartedAt: order.executionStartedAt,
      },
      args.staleClaimMs,
    );
    if (!decision.ok) {
      return {
        ok: false,
        status: order.status as OrderStatus,
        reason: decision.reason ?? "claim_refused",
      };
    }

    const now = Date.now();
    // Refresh the one-shot claim timestamp (also the stale-claim heartbeat),
    // count the genuine execution attempt, and clear the previous attempt's
    // error on (re)claim.
    await ctx.db.patch(args.orderId, {
      status: "executing",
      executionStartedAt: now,
      updatedAt: now,
      error: undefined,
      executionAttempts: (order.executionAttempts ?? 0) + 1,
    });
    return { ok: true, status: "executing" };
  },
});

/**
 * Internal: recovery edge for orders that failed BEFORE the retry path
 * existed (failed was terminal then). Re-queues onto failed_retriable ONLY
 * when the order is genuinely paid (persisted paymentConfirmedAt) AND the
 * recorded failure classifies as transient. Payment evidence, payment link,
 * and transaction URL are untouched; no payment link is created.
 */
export const recoverFailedOrderInternal = internalMutation({
  args: { orderId: v.id("orders") },
  handler: async (ctx, args): Promise<TransitionResult> => {
    const order = await ctx.db.get(args.orderId);
    if (!order) return { ok: false, status: "failed", reason: "order_not_found" };

    const decision = evaluateFailureRecovery({
      status: order.status,
      paymentConfirmedAt: order.paymentConfirmedAt,
      error: order.error ?? "",
    });
    if (!decision.ok) {
      return {
        ok: false,
        status: order.status as OrderStatus,
        reason: decision.reason ?? "recovery_refused",
      };
    }

    const now = Date.now();
    await ctx.db.patch(args.orderId, {
      status: "failed_retriable",
      failureKind: "transient",
      updatedAt: now,
    });
    return { ok: true, status: "failed_retriable" };
  },
});

/** Internal: record the measured execution time on completion. */
export const recordExecutionInternal = internalMutation({
  args: { orderId: v.id("orders"), executedMs: v.number() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.orderId, {
      executedMs: args.executedMs,
      updatedAt: Date.now(),
    });
  },
});

/** Internal: store the transaction URL reported by Moove once paid. */
export const setTransactionUrlInternal = internalMutation({
  args: { orderId: v.id("orders"), transactionUrl: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.orderId, {
      mooveTransactionUrl: args.transactionUrl,
      updatedAt: Date.now(),
    });
  },
});

/** Internal: observe Moove's link status without any state transition. */
export const observeLinkStatusInternal = internalMutation({
  args: { orderId: v.id("orders"), mooveLinkStatus: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.orderId, {
      mooveLinkStatus: args.mooveLinkStatus,
      updatedAt: Date.now(),
    });
  },
});

/** Internal: raw fetch of an order by id for actions (no auth context). */
export const getByIdInternal = internalQuery({
  args: { orderId: v.id("orders") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.orderId);
  },
});

/**
 * Internal: idempotently persist the research result.
 * Invariant enforced here: sourcesCount must equal sources.length, so a
 * persisted row can never claim a different count than it actually holds.
 */
export const saveResultInternal = internalMutation({
  args: {
    orderId: v.id("orders"),
    query: v.string(),
    sources: v.array(
      v.object({
        title: v.string(),
        authors: v.array(v.string()),
        published: v.string(),
        absUrl: v.string(),
        pdfUrl: v.string(),
        summary: v.string(),
      }),
    ),
    synthesis: v.string(),
    keyFindings: v.array(v.string()),
    confidence: v.number(),
    sourcesCount: v.number(),
    generatedAt: v.string(),
    measuredMs: v.number(),
    provider: v.string(),
  },
  handler: async (ctx, args) => {
    if (args.sourcesCount !== args.sources.length) {
      throw new Error(
        `sources_count_mismatch: counted ${args.sources.length}, claimed ${args.sourcesCount}`,
      );
    }
    const existing = await ctx.db
      .query("researchResults")
      .withIndex("by_orderId", (q) => q.eq("orderId", args.orderId))
      .first();
    if (existing) return existing._id;
    return await ctx.db.insert("researchResults", {
      orderId: args.orderId,
      query: args.query,
      sources: args.sources,
      synthesis: args.synthesis,
      keyFindings: args.keyFindings,
      confidence: args.confidence,
      sourcesCount: args.sourcesCount,
      generatedAt: args.generatedAt,
      measuredMs: args.measuredMs,
      provider: args.provider,
    });
  },
});

/** Internal: idempotently persist the receipt. */
export const saveReceiptInternal = internalMutation({
  args: { orderId: v.id("orders"), receipt: v.any() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("receipts")
      .withIndex("by_orderId", (q) => q.eq("orderId", args.orderId))
      .first();
    if (existing) return existing._id;
    return await ctx.db.insert("receipts", {
      orderId: args.orderId,
      receipt: args.receipt,
      createdAt: Date.now(),
    });
  },
});

/** Internal: fetch a persisted research result by order id (for actions). */
export const getResearchResultInternal = internalQuery({
  args: { orderId: v.id("orders") },
  handler: async (ctx, args): Promise<Doc<"researchResults"> | null> => {
    return (
      (await ctx.db
        .query("researchResults")
        .withIndex("by_orderId", (q) => q.eq("orderId", args.orderId))
        .first()) ?? null
    );
  },
});

/**
 * Machine API: fetch an order by id, authorized by the SHA-256 hash of its
 * per-order capability token. No user identity is involved. Confirmed
 * execution is included when present, so the machine sees the full
 * machine-readable result. This is a read-only view — it can never mutate
 * order state or confirm a payment.
 */
export const getByTokenHashInternal = internalQuery({
  args: { orderId: v.id("orders"), tokenHash: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{
    order: Doc<"orders">;
    result: Doc<"researchResults"> | null;
    receipt: Doc<"receipts"> | null;
  } | null> => {
    const order = await ctx.db.get(args.orderId);
    if (!order) return null;
    if (
      !order.orderTokenHash ||
      !isHex64(args.tokenHash) ||
      !constantTimeHexEqual(order.orderTokenHash, args.tokenHash)
    ) {
      return null; // not found OR unauthorized — never distinguish
    }
    const result =
      (await ctx.db
        .query("researchResults")
        .withIndex("by_orderId", (q) => q.eq("orderId", args.orderId))
        .first()) ?? null;
    const receipt =
      (await ctx.db
        .query("receipts")
        .withIndex("by_orderId", (q) => q.eq("orderId", args.orderId))
        .first()) ?? null;
    return { order, result, receipt };
  },
});

/**
 * Internal: raw fetch of an order plus its persisted result and receipt for
 * the public proof endpoint (GET /api/proof/:orderId). Read-only, no auth:
 * the HTTP layer serves ONLY the allowlist projection (buildPublicProof) of
 * these rows — never the raw rows, token hashes, user identity, or payment
 * URL. Unknown ids return null and the endpoint answers 404.
 */
export const getProofInternal = internalQuery({
  args: { orderId: v.id("orders") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    order: Doc<"orders">;
    result: Doc<"researchResults"> | null;
    receipt: Doc<"receipts"> | null;
  } | null> => {
    const order = await ctx.db.get(args.orderId);
    if (!order) return null;
    const result =
      (await ctx.db
        .query("researchResults")
        .withIndex("by_orderId", (q) => q.eq("orderId", args.orderId))
        .first()) ?? null;
    const receipt =
      (await ctx.db
        .query("receipts")
        .withIndex("by_orderId", (q) => q.eq("orderId", args.orderId))
        .first()) ?? null;
    return { order, result, receipt };
  },
});

/**
 * Public query: the signed-in user's orders, newest first.
 * The frontend can NEVER mark a payment confirmed — it can only observe
 * status, which only server-side Moove polling mutates.
 */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const orders = await ctx.db
      .query("orders")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .order("desc")
      .take(20);
    return orders;
  },
});

/** Public query: the persisted result for an order (owner only). */
export const getResult = query({
  args: { orderId: v.id("orders") },
  handler: async (ctx, args): Promise<Doc<"researchResults"> | null> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const order = await ctx.db.get(args.orderId);
    if (!order || order.userId !== userId) return null;
    const result = await ctx.db
      .query("researchResults")
      .withIndex("by_orderId", (q) => q.eq("orderId", args.orderId))
      .first();
    return result ?? null;
  },
});

/** Public query: the persisted receipt for an order (owner only). */
export const getReceipt = query({
  args: { orderId: v.id("orders") },
  handler: async (ctx, args): Promise<Doc<"receipts"> | null> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const order = await ctx.db.get(args.orderId);
    if (!order || order.userId !== userId) return null;
    const receipt = await ctx.db
      .query("receipts")
      .withIndex("by_orderId", (q) => q.eq("orderId", args.orderId))
      .first();
    return receipt ?? null;
  },
});
