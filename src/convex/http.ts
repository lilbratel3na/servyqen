import { httpRouter } from "convex/server";
import type { GenericActionCtx } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { auth } from "./auth";
import { RESEARCH_SERVICE } from "../lib/agentgate-contract";
import {
  hashToken,
  isHex64,
  randomToken,
  validateOrderRequest,
} from "../lib/agentgate-machine-pure";

const http = httpRouter();

// Auth routes (template requirement, do not remove).
auth.addHttpRoutes(http);

const jsonHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const errorJson = (status: number, code: string) =>
  new Response(JSON.stringify({ error: code }), { status, headers: jsonHeaders });

// ---------------------------------------------------------------------------
// Capability-token helpers (WebCrypto; bundleable in the HTTP router runtime).
// Design: a 256-bit random token returned exactly once by POST /api/orders;
// only its SHA-256 hash is persisted on the order row. Wrong/missing tokens
// are indistinguishable from nonexistent orders (same 404).
// ---------------------------------------------------------------------------


/** Bearer-token extraction; malformed or missing tokens yield "". */
function bearerToken(request: Request): string {
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return isHex64(token) ? token : "";
}

/** Extract an order id from /api/orders/:id or /api/orders/:id/run. */
function orderIdFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/api\/orders\/([^/]+?)(?:\/run)?$/);
  return m?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Public machine API
// ---------------------------------------------------------------------------

/** Discovery index: the list of services AgentGate exposes. */
export const listServices = httpAction(async () => {
  return new Response(
    JSON.stringify(
      {
        protocol: RESEARCH_SERVICE.protocol,
        services: [
          {
            id: RESEARCH_SERVICE.id,
            name: RESEARCH_SERVICE.name,
            version: RESEARCH_SERVICE.version,
            price: `${RESEARCH_SERVICE.payment.amount} ${RESEARCH_SERVICE.payment.currency}`,
            contractUrl: `/api/services/${RESEARCH_SERVICE.id}/contract`,
          },
        ],
      },
      null,
      2,
    ),
    { status: 200, headers: jsonHeaders },
  );
});

/** Full machine-readable service contract for the AI Research service. */
export const getServiceContract = httpAction(async () => {
  return new Response(JSON.stringify(RESEARCH_SERVICE, null, 2), {
    status: 200,
    headers: jsonHeaders,
  });
});

/**
 * POST /api/orders — machine order creation.
 * Accepts { "query": "..." }, creates exactly ONE order with exactly ONE
 * genuine Moove payment link (existing moove.ts integration), and returns
 * the order id, Moove payment link id, payment URL, and the per-order
 * capability token. The token is returned EXACTLY ONCE; only its SHA-256
 * hash is persisted. This route cannot confirm payments — confirmation is
 * exclusively Moove's documented status endpoint via internal.moove.
 */
export const createOrder = httpAction(async (ctx, request) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorJson(400, "invalid_json");
  }

  const check = validateOrderRequest(body as { query?: unknown });
  if (!check.ok) {
    return new Response(JSON.stringify({ error: check.error }), {
      status: 400,
      headers: jsonHeaders,
    });
  }

  // Capability token: 256-bit random; raw shown once, hash persisted.
  const token = randomToken();
  const tokenHash = await hashToken(token);

  try {
    const orderId = await ctx.runAction(internal.machineapi.createMachineOrder, {
      query: check.query,
      orderTokenHash: tokenHash,
    });
    const order = await ctx.runQuery(internal.orders.getByIdInternal, {
      orderId: orderId as Id<"orders">,
    });
    if (!order?.moovePaymentLinkId || !order.moovePaymentUrl) {
      return errorJson(502, "payment_link_missing");
    }
    return new Response(
      JSON.stringify(
        {
          orderId,
          paymentLinkId: order.moovePaymentLinkId,
          paymentUrl: order.moovePaymentUrl,
          status: order.status,
          capabilityToken: token,
          note: "Store the capabilityToken now: it is returned once and is required for all subsequent access to this order. The human completes payment at paymentUrl; confirmation is performed server-side from Moove's status endpoint only.",
        },
        null,
        2,
      ),
      { status: 201, headers: jsonHeaders },
    );
  } catch {
    // Never leak upstream error text to machines; the link simply failed.
    return errorJson(502, "payment_link_unavailable");
  }
});

/** Render the authorized machine view of an order. */
function renderOrderPayload(found: {
  order: Doc<"orders">;
  result: Doc<"researchResults"> | null;
  receipt: { receipt: unknown } | null;
}): Response {
  const { order, result, receipt } = found;
  const payload: Record<string, unknown> = {
    orderId: order._id,
    serviceId: order.serviceId,
    status: order.status,
    query: order.query,
    amount: order.amount,
    currency: order.currency,
    paymentLinkId: order.moovePaymentLinkId ?? null,
    paymentUrl: order.moovePaymentUrl ?? null,
    mooveLinkStatus: order.mooveLinkStatus ?? null,
    transactionUrl: order.mooveTransactionUrl ?? null,
    error: order.error ?? null,
    // "transient" | "permanent" for failed/failed_retriable orders: transient
    // execution failures of PAID orders are re-runnable at no charge via
    // POST /api/orders/:id/run (never a new payment link); permanent contract
    // failures are terminal.
    failureKind: order.failureKind ?? null,
    executionAttempts: order.executionAttempts ?? 0,
    executedMs: order.executedMs ?? null,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    paymentConfirmedAt: order.paymentConfirmedAt ?? null,
    completedAt: order.completedAt ?? null,
    // Machine-readable result and receipt, present once execution completes.
    result:
      order.status === "completed" && result
        ? {
            query: result.query,
            sources: result.sources,
            sourcesCount: result.sourcesCount,
            synthesis: result.synthesis,
            keyFindings: result.keyFindings,
            confidence: result.confidence,
            generatedAt: result.generatedAt,
            measuredMs: result.measuredMs,
            provider: result.provider,
          }
        : null,
    receipt: receipt?.receipt ?? null,
  };
  return new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: jsonHeaders,
  });
}

/** GET /api/orders/:id — capability-token-authorized machine order view. */
export const getOrder = httpAction(async (ctx, request) => {
  const orderId = orderIdFromPath(new URL(request.url).pathname);
  if (!orderId) return errorJson(404, "not_found");

  const token = bearerToken(request);
  if (!token) return errorJson(404, "not_found");

  const tokenHash = await hashToken(token);
  const found = await ctx.runQuery(internal.orders.getByTokenHashInternal, {
    orderId: orderId as Id<"orders">,
    tokenHash,
  });
  if (!found) return errorJson(404, "not_found");

  return renderOrderPayload(found);
});

/**
 * POST /api/orders/:id/run — capability-token-authorized execution trigger.
 * Polls the REAL Moove status endpoint until genuinely confirmed or timed
 * out, then executes the service under the same one-shot claim, payment
 * gate, and honest-failure rules as the dashboard path. Nothing here can
 * fabricate a confirmation.
 */
async function handleRunOrder(
  ctx: GenericActionCtx<any>,
  request: Request,
  orderId: string,
): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return errorJson(404, "not_found");

  const tokenHash = await hashToken(token);
  const found = await ctx.runQuery(internal.orders.getByTokenHashInternal, {
    orderId: orderId as Id<"orders">,
    tokenHash,
  });
  if (!found) return errorJson(404, "not_found");

  // Legacy recovery: an order left terminal `failed` by the pre-retry state
  // machine is re-queued onto failed_retriable when it is genuinely PAID
  // (persisted confirmation evidence) and its error classifies as transient.
  // Refusals (unpaid, permanent failure, non-failed status) are benign no-ops;
  // the execution claim enforces the same gates independently. Payment
  // evidence and the payment link are untouched — no link is ever created.
  await ctx.runMutation(internal.orders.recoverFailedOrderInternal, {
    orderId: orderId as Id<"orders">,
  });

  const run = await ctx.runAction(internal.machineapi.runMachineOrder, {
    orderId: orderId as Id<"orders">,
  });

  const order = await ctx.runQuery(internal.orders.getByIdInternal, {
    orderId: orderId as Id<"orders">,
  });

  return new Response(
    JSON.stringify(
      { orderId, ...run, finalStatus: order?.status ?? run.status },
      null,
      2,
    ),
    { status: 200, headers: jsonHeaders },
  );
}

export const runOrder = httpAction(async (ctx, request) => {
  const orderId = orderIdFromPath(new URL(request.url).pathname);
  if (!orderId) return errorJson(404, "not_found");
  return await handleRunOrder(ctx, request, orderId);
});

/**
 * Dispatcher for POSTs under /api/orders/ — Convex routes support exact
 * paths or prefixes, not wildcard segments, so :id/run is matched here.
 */
export const postOrderRouter = httpAction(async (ctx, request) => {
  const pathname = new URL(request.url).pathname;
  if (/^\/api\/orders\/[^/]+\/run$/.test(pathname)) {
    const orderId = orderIdFromPath(pathname);
    if (orderId) return await handleRunOrder(ctx, request, orderId);
  }
  return errorJson(404, "not_found");
});

http.route({
  pathPrefix: "/api/services/",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: jsonHeaders })),
});

http.route({
  pathPrefix: "/api/orders/",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: jsonHeaders })),
});

http.route({
  path: "/api/orders",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: jsonHeaders })),
});

http.route({
  path: "/api/services",
  method: "GET",
  handler: listServices,
});

http.route({
  path: `/api/services/${RESEARCH_SERVICE.id}/contract`,
  method: "GET",
  handler: getServiceContract,
});

http.route({
  path: "/api/orders",
  method: "POST",
  handler: createOrder,
});

http.route({
  pathPrefix: "/api/orders/",
  method: "GET",
  handler: getOrder,
});

http.route({
  pathPrefix: "/api/orders/",
  method: "POST",
  handler: postOrderRouter,
});

export default http;
