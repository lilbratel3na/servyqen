"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { RESEARCH_SERVICE } from "../lib/agentgate-contract";

const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 40; // ~2 minutes of documented polling

/**
 * Public entry point: initiate an order for the AI Research service.
 * Creates a REAL Moove payment link and returns the genuine payment URL.
 */
export const initiateOrder = action({
  args: { query: v.string() },
  handler: async (ctx, args): Promise<{ orderId: string; paymentUrl: string }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("unauthenticated");
    if (args.query.trim().length < 8 || args.query.length > 512) {
      throw new Error("query must be between 8 and 512 characters");
    }

    const { orderId } = await ctx.runAction(internal.moove.initiateOrder, {
      userId,
      query: args.query.trim(),
    });

    const order = await ctx.runQuery(internal.orders.getByIdInternal, {
      orderId: orderId as any,
    });
    if (!order?.moovePaymentUrl) throw new Error("payment_url_missing");

    return { orderId, paymentUrl: order.moovePaymentUrl };
  },
});

/**
 * Public entry point: wait for GENUINE payment confirmation by polling the
 * real Moove status endpoint (the documented reconciliation mechanism), then
 * execute the service. Confirms nothing by frontend action; every
 * confirmation decision comes from Moove's reported link status.
 */
export const runOrder = action({
  args: { orderId: v.id("orders") },
  handler: async (ctx, args): Promise<{
    ok: boolean;
    status: string;
    error?: string;
  }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("unauthenticated");

    const order = await ctx.runQuery(internal.orders.getByIdInternal, {
      orderId: args.orderId,
    });
    if (!order) throw new Error("order_not_found");
    if (order.userId !== userId) throw new Error("forbidden");

    // Poll the real Moove link status until confirmed or timed out.
    for (let i = 0; i < MAX_POLLS; i++) {
      const check = await ctx.runAction(internal.moove.checkPayment, {
        orderId: args.orderId,
      });

      if (check.confirmed) {
        // Genuinely confirmed server-side; run the research service.
        const result = await ctx.runAction(internal.research.executeService, {
          orderId: args.orderId,
        });
        return {
          ok: result.ok,
          status: result.ok ? "completed" : "failed",
          error: result.error,
        };
      }

      if (check.status === "expired") return { ok: false, status: "expired" };

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    return {
      ok: false,
      status: "awaiting_payment",
      error: "payment_confirmation_timeout",
    };
  },
});

/** Agent-facing machine-readable contract endpoint (also served over HTTP). */
export const getServiceContract = action({
  args: {},
  handler: async (): Promise<typeof RESEARCH_SERVICE> => {
    return RESEARCH_SERVICE;
  },
});
