"use node";

/**
 * Machine-facing AgentGate order orchestration (used by the HTTP routes in
 * http.ts: POST /api/orders, GET /api/orders/:id, POST /api/orders/:id/run).
 *
 * Payment integrity (unchanged from V1):
 *  - Nothing in this module — and no HTTP route — can mark a payment as
 *    completed. The only path to payment_confirmed runs through
 *    internal.moove.checkPayment, which asks Moove's documented status
 *    endpoint GET /v1/payment-link/{id} and accepts nothing else.
 *  - All status changes flow through the guarded state machine
 *    (orders.transitionInternal, canTransition-enforced) and the one-shot
 *    claim (orders.claimExecutingInternal), unchanged.
 *  - Capability-token crypto/validation lives in
 *    src/lib/agentgate-machine-pure.ts (pure, unit-tested); this module is
 *    orchestration only.
 */

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

/**
 * Genuine Moove polling cadence — kept identical to agentgate.ts (documented
 * reconciliation mechanism, ~2 minutes of polling).
 */
const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 40;

/**
 * Machine order creation: creates ONE order with ONE genuine Moove payment
 * link via the existing Moove integration. userId is undefined for machine
 * orders; their access is exclusively the per-order capability token whose
 * SHA-256 hash (orderTokenHash) is passed in already computed.
 */
export const createMachineOrder = internalAction({
  args: {
    query: v.string(),
    orderTokenHash: v.string(),
  },
  handler: async (ctx, args): Promise<string> => {
    const { orderId } = await ctx.runAction(internal.moove.initiateOrder, {
      query: args.query,
      orderTokenHash: args.orderTokenHash,
    });
    return orderId;
  },
});

/**
 * Machine polling loop: identical semantics to the dashboard's
 * agentgate.runOrder — poll the REAL Moove status endpoint until genuinely
 * confirmed or timed out, then execute. No token is ever accepted as payment
 * evidence. Confirmed → claim → arXiv execution → persist → receipt, all via
 * the same internals the dashboard path uses.
 */
export const runMachineOrder = internalAction({
  args: { orderId: v.id("orders") },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: boolean; status: string; error?: string }> => {
    for (let i = 0; i < MAX_POLLS; i++) {
      const check = await ctx.runAction(internal.moove.checkPayment, {
        orderId: args.orderId,
      });

      if (check.confirmed) {
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
