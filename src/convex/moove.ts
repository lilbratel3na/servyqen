"use node";

/**
 * Moove Agentic Payments integration — AgentGate V1.
 *
 * Uses ONLY the endpoints and semantics documented at docs.moove.xyz:
 *  - POST /v1/payment-link  (scope payment_link:create)  -> { id, url }
 *  - GET  /v1/payment-link/{id}  (public, unauthenticated) -> PaymentLinkData
 *    with status active | completed | inactive, receivedAmount, transactionUrl.
 *  - Confirmation = the documented polling mechanism ("There are no webhooks
 *    yet. Poll GET /v1/payment-link on a sensible interval to reconcile."),
 *    where a link with maxUsage=1 reaches status "completed" once paid and
 *    transactionUrl becomes non-null.
 *
 * No webhooks, escrow, conditional release, or outbound transfers are used —
 * those are not documented capabilities of this API.
 *
 * MOOVE_API_KEY is read from the server-side environment only. It is never
 * returned to the client and never committed to source control.
 */

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  MOOVE_BASE_URL,
  MOOVE_LINK_VALIDITY_MS,
  ORDER_EXPIRY_MS,
  RESEARCH_SERVICE,
} from "../lib/agentgate-contract";

interface MooveCreateLinkResponse {
  id: string;
  url: string;
}

export interface MooveLinkData {
  id: string;
  status: "active" | "completed" | "inactive";
  receivedAmount: string | null;
  transactionUrl: string | null;
  expirationDate: string | null;
}

const MOOVE_TIMEOUT_MS = 10_000;

function mooveApiKey(): string {
  const key = process.env.MOOVE_API_KEY;
  if (!key) {
    throw new Error(
      "MOOVE_API_KEY is not configured. Add it via the project's Keys/API keys UI; AgentGate will not simulate payments.",
    );
  }
  return key;
}

async function mooveFetch<T>(
  path: string,
  init?: { method?: "GET" | "POST"; body?: string },
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MOOVE_TIMEOUT_MS);
  try {
    const res = await fetch(`${MOOVE_BASE_URL}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.method === "POST" ? { "X-API-Key": mooveApiKey() } : {}),
      },
      body: init?.body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Moove API error ${res.status}: ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Initiate an order: create a genuine Moove payment link (documented endpoint)
 * and persist the order with its payment link id and URL.
 */
export const initiateOrder = internalAction({
  args: {
    userId: v.optional(v.id("users")),
    query: v.string(),
    orderTokenHash: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ orderId: Id<"orders"> }> => {
    // 1. Create the real payment link for exactly 1 USDC-equivalent amount.
    //    expirationDate is a documented field; it outlives our own order window
    //    so the link can never stop accepting payments while the order is
    //    still awaiting_payment.
    const link = await mooveFetch<MooveCreateLinkResponse>("/v1/payment-link", {
      method: "POST",
      body: JSON.stringify({
        // Denominated in the settlement token (USDC, 6 decimals per docs).
        // Sent as a string to avoid floating-point rounding (documented).
        toAmount: RESEARCH_SERVICE.payment.amount,
        description: `${RESEARCH_SERVICE.id} — ${RESEARCH_SERVICE.name}: ${args.query.slice(0, 180)}`,
        maxUsage: 1, // single-use invoice: completes the moment it is paid
        expirationDate: new Date(
          Date.now() + MOOVE_LINK_VALIDITY_MS,
        ).toISOString(),
      }),
    });

    // 2. Persist the order with the genuine payment id + URL.
    const orderId: Id<"orders"> = await ctx.runMutation(
      internal.orders.createInternal,
      {
        userId: args.userId,
        orderTokenHash: args.orderTokenHash,
        serviceId: RESEARCH_SERVICE.id,
        query: args.query,
        amount: RESEARCH_SERVICE.payment.amount,
        currency: RESEARCH_SERVICE.payment.currency,
        paymentLinkId: link.id,
        paymentUrl: link.url,
      },
    );

    return { orderId };
  },
});

/**
 * Check payment confirmation from the REAL Moove status endpoint.
 * Confirmed === the documented status "completed" for a maxUsage=1 link.
 * This is the only path that can move an order past awaiting_payment.
 */
export const checkPayment = internalAction({
  args: { orderId: v.id("orders") },
  handler: async (ctx, args): Promise<{
    status: string;
    mooveLinkStatus: string;
    confirmed: boolean;
  }> => {
    const order = await ctx.runQuery(internal.orders.getByIdInternal, {
      orderId: args.orderId,
    });
    if (!order) throw new Error("order_not_found");
    if (!order.moovePaymentLinkId) throw new Error("order_has_no_payment_link");

    const link = await mooveFetch<MooveLinkData>(
      `/v1/payment-link/${encodeURIComponent(order.moovePaymentLinkId)}`,
    );

    if (link.transactionUrl && link.transactionUrl !== order.mooveTransactionUrl) {
      await ctx.runMutation(internal.orders.setTransactionUrlInternal, {
        orderId: args.orderId,
        transactionUrl: link.transactionUrl,
      });
    }

    // Confirmation: documented "completed" status, or the on-chain transaction
    // URL Moove sets once a payment settles. Both mean the same thing for a
    // maxUsage=1 link; either is genuine evidence of payment.
    const confirmed = link.status === "completed" || !!link.transactionUrl;

    if (confirmed) {
      await ctx.runMutation(internal.orders.transitionInternal, {
        orderId: args.orderId,
        to: "payment_confirmed",
        mooveLinkStatus: link.status,
      });
      const current = await ctx.runQuery(internal.orders.getByIdInternal, {
        orderId: args.orderId,
      });
      return {
        status: current?.status ?? "payment_confirmed",
        mooveLinkStatus: link.status,
        confirmed: true,
      };
    }

    // Unpaid: mark our own order expired after ORDER_EXPIRY_MS. Deliberately
    // conservative and money-safe: the Moove link outlives this window
    // (MOOVE_LINK_VALIDITY_MS > ORDER_EXPIRY_MS), so if the payer really does
    // pay late, checkPayment can still transition expired -> payment_confirmed
    // and the customer gets the service they paid for.
    if (order.status === "awaiting_payment" && Date.now() - order.createdAt > ORDER_EXPIRY_MS) {
      await ctx.runMutation(internal.orders.transitionInternal, {
        orderId: args.orderId,
        to: "expired",
        mooveLinkStatus: link.status,
      });
      return { status: "expired", mooveLinkStatus: link.status, confirmed: false };
    }

    // Not yet paid: observe the link status without any state transition.
    await ctx.runMutation(internal.orders.observeLinkStatusInternal, {
      orderId: args.orderId,
      mooveLinkStatus: link.status,
    });

    return { status: order.status, mooveLinkStatus: link.status, confirmed: false };
  },
});
