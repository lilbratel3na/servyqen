/**
 * AgentGate service contract — single source of truth.
 *
 * The AI Research service: an AI agent discovers this service, reads its
 * machine-readable contract, initiates a genuine Moove payment for 1 USDC,
 * waits for genuine payment confirmation via Moove's documented status
 * mechanism, and receives a machine-readable result plus receipt.
 *
 * This module is imported by both the Convex backend (to validate the order
 * flow) and the frontend (to render the contract). The public agent-facing
 * contract endpoint (src/convex/http.ts) returns this object as JSON.
 */

export const AGENTGATE_SERVICE_ID = "ai-research-v1";

/**
 * Moove API facts, verified against the official docs (docs.moove.xyz):
 * - Base URL: https://api.moove.xyz
 * - Auth: X-API-Key header. Scopes: payment_link:create / payment_link:read.
 * - POST /v1/payment-link { toAmount, description, maxUsage, expirationDate }
 *   -> { id, url }
 * - GET /v1/payment-link/{id} -> PaymentLinkData with status
 *   active | completed | inactive, receivedAmount, transactionUrl, token.
 * - "There are no webhooks yet. Poll GET /v1/payment-link on a sensible
 *   interval to reconcile." (official API reference)
 *
 * Nothing beyond these documented endpoints and semantics is used.
 */
export const MOOVE_BASE_URL = "https://api.moove.xyz";

export const RESEARCH_SERVICE = {
  id: AGENTGATE_SERVICE_ID,
  name: "AI Research Service",
  version: "1.0.0",
  description:
    "Given a research query, retrieves five real, verifiable academic sources and returns a machine-readable research result: exactly 5 sources, a synthesis, key findings, and a confidence score.",
  protocol: "AgentGate/1.0",
  provider: {
    name: "AgentGate (ProofFlow V1)",
    docs: "/api/services/ai-research-v1/contract",
  },
  payment: {
    provider: "Moove Agentic Payments",
    docs: "https://docs.moove.xyz",
    method: "moove_payment_link",
    currency: "USDC",
    // Variable per-order pricing: each POST /api/orders names its EXACT price
    // (>= minimumAmount). "amount" is the default applied when the caller
    // omits `amount` — kept for backward compatibility with existing readers.
    amount: "1",
    minimumAmount: "1",
    pricingModel:
      "per_order_exact_amount: the caller sets the exact price per order via the optional 'amount' string in POST /api/orders (default '1'). Minimum 1 USDC; at most 6 decimal places (USDC precision). The payer CANNOT edit the amount — the hosted Moove checkout enforces the order's fixed toAmount. Denominated in USDC, not USD.",
    amountUnit: "USDC (settlement token of the merchant's default wallet)",
    confirmation:
      "Payment is confirmed server-side by polling Moove's documented payment-link status endpoint until status === 'completed'. No frontend action can confirm a payment.",
  },
  execution: {
    slaTargetMs: 5000,
    slaNote:
      "5000ms is an execution TARGET, not a guarantee. Every response reports the measured wall-clock execution time (executedMs); never a hardcoded value.",
  },
  input: {
    type: "object",
    required: ["query"],
    properties: {
      query: {
        type: "string",
        description:
          "The research question to investigate. One query per order.",
        minLength: 8,
        maxLength: 512,
      },
    },
  },
  output: {
    type: "object",
    required: ["sources", "synthesis", "keyFindings", "confidence"],
    properties: {
      sources: {
        type: "array",
        minItems: 5,
        maxItems: 5,
        description:
          "Exactly five real, verifiable academic sources (arXiv preprints) with title, authors, publication date, abstract URL, PDF URL, and a per-source summary.",
        items: {
          type: "object",
          required: [
            "title",
            "authors",
            "published",
            "absUrl",
            "pdfUrl",
            "summary",
          ],
        },
      },
      synthesis: {
        type: "string",
        description:
          "Extractive synthesis of what the sources collectively say about the query: deterministic and produced without a language model; every statement is quoted verbatim from a retrieved abstract.",
      },
      keyFindings: {
        type: "array",
        items: { type: "string" },
        description:
          "One finding per source: a verbatim excerpt selected from that source's abstract and attributed to the real paper title. Nothing is invented.",
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description:
          "Computed deterministically (not model-reported): the fraction of the five retrieved sources whose title or abstract contains at least one meaningful term of the research query, in [0,1].",
      },
    },
  },
  endpoints: {
    discovery: "GET /api/services",
    contract: "GET /api/services/ai-research-v1/contract",
    initiate:
      "POST /api/orders {query, amount?} -> 201 { orderId, paymentLinkId, paymentUrl, capabilityToken }; amount is the EXACT per-order price in USDC (default '1', minimum '1', at most 6 decimal places, string decimal — the payer cannot edit it at checkout); the capability token is a 256-bit per-order secret returned exactly once — only its hash is stored",
    order:
      "GET /api/orders/:id with Authorization: Bearer <capabilityToken> -> full machine-readable order state, result, and receipt",
    run:
      "POST /api/orders/:id/run with Authorization: Bearer <capabilityToken> -> polls genuine Moove confirmation server-side, then executes; nothing can fabricate a confirmation. A PAID order whose execution fails transiently (timeout/network/provider outage) lands in failed_retriable and can be re-run at no charge; a retry re-verifies payment with Moove and never creates a payment link. Permanent contract failures (e.g. fewer than 5 verifiable sources) are terminal failed.",
    payment:
      "The human completes the hosted Moove payment at paymentUrl. Agents do not spend from a wallet; machine-side confirmation comes only from Moove's documented status endpoint.",
  },
} as const;

/**
 * Order payment window (our own expiry policy, shared by moove.ts).
 * An unpaid order expires after this long — but the Moove link outlives the
 * window (see MOOVE_LINK_VALIDITY_MS), so a genuinely late payment is still
 * recoverable rather than silently stealing the payer's money.
 */
export const ORDER_EXPIRY_MS = 60 * 60 * 1000;

/**
 * Validity we request on every Moove payment link (expirationDate).
 * Deliberately LONGER than ORDER_EXPIRY_MS so the link can never stop
 * accepting payments while our order is still awaiting_payment.
 */
export const MOOVE_LINK_VALIDITY_MS = 48 * 60 * 60 * 1000;

/**
 * An order stuck in `executing` for longer than this is considered a crashed
 * run and may be reclaimed for a retry. Must exceed the worst-case execution
 * budget (arXiv fetch + synthesis timeouts + Convex action overhead).
 */
export const EXECUTION_CLAIM_STALE_MS = 3 * 60 * 1000;

/** The order state machine, enforced server-side. */
export const ORDER_STATES = [
  "awaiting_payment",
  "payment_confirmed",
  "executing",
  "completed",
  "failed",
  "failed_retriable",
  "expired",
] as const;
export type OrderStatus = (typeof ORDER_STATES)[number];

/**
 * Legal transitions of the state machine.
 *
 * failed_retriable: a PAID order whose execution failed transiently
 * (timeout / network / provider outage). It may re-enter execution through
 * the one-shot claim, which independently requires persisted payment
 * confirmation evidence (paymentConfirmedAt) — an unpaid order can never
 * ride the retry path. There is deliberately NO edge back to
 * payment_confirmed from failed_retriable: a retry re-verifies payment with
 * Moove but must never rewrite the original paymentConfirmedAt evidence.
 */
export const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  awaiting_payment: ["payment_confirmed", "expired", "failed"],
  payment_confirmed: ["executing", "failed"],
  executing: ["completed", "failed", "failed_retriable"],
  completed: [],
  // Recovery only: orders failed before the retry path existed may be
  // re-queued IF genuinely paid AND the recorded error is transient.
  failed: ["failed_retriable"],
  failed_retriable: ["executing"],
  // Recovery only: the Moove link stays payable longer than our order window,
  // so a customer who genuinely paid after expiry must get the service.
  expired: ["payment_confirmed"],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}
