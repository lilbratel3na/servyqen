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
  ORDER_STATES,
  type OrderStatus,
} from "../lib/agentgate-contract";

export const ORDER_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes to pay

function normalizeStatus(status: string): OrderStatus {
  if ((ORDER_STATES as readonly string[]).includes(status)) {
    return status as OrderStatus;
  }
  throw new Error(`Invalid order status: ${status}`);
}

function assertTransition(from: OrderStatus, to: OrderStatus) {
  if (!canTransition(from, to)) {
    throw new Error(
      `Illegal order state transition: ${from} -> ${to}`,
    );
  }
}

/** Internal: create a new order in awaiting_payment. */
export const createInternal = internalMutation({
  args: {
    userId: v.id("users"),
    serviceId: v.string(),
    query: v.string(),
    amount: v.string(),
    currency: v.string(),
    paymentLinkId: v.string(),
    paymentUrl: v.string(),
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
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Internal: guarded status transition. */
export const transitionInternal = internalMutation({
  args: {
    orderId: v.id("orders"),
    to: v.string(),
    mooveLinkStatus: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    ok: boolean;
    status: OrderStatus;
    reason?: string;
  }> => {
    const order = await ctx.db.get(args.orderId);
    if (!order) return { ok: false, status: "failed", reason: "order_not_found" };

    const from = normalizeStatus(order.status);
    const to = normalizeStatus(args.to);
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

    await ctx.db.patch(args.orderId, patch);
    return { ok: true, status: to };
  },
});

/** Internal: record the measured execution time after completion. */
export const recordExecutionInternal = internalMutation({
  args: { orderId: v.id("orders"), executedMs: v.number() },
  handler: async (ctx, args) => {
    const order = await ctx.db.get(args.orderId);
    if (!order) throw new Error("order_not_found");
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

/** Internal: idempotently persist the research result. */
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
  handler: async (ctx, args) => {
    return (
      (await ctx.db
        .query("researchResults")
        .withIndex("by_orderId", (q) => q.eq("orderId", args.orderId))
        .first()) ?? null
    );
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

/** Public query: a single order, only readable by its owner. */
export const getMine = query({
  args: { orderId: v.id("orders") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const order = await ctx.db.get(args.orderId);
    if (!order || order.userId !== userId) return null;
    return order;
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
