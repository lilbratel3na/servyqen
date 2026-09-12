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
    amount: "1",
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
          "A synthesis of what the sources collectively say about the query.",
      },
      keyFindings: {
        type: "array",
        items: { type: "string" },
        description: "Concrete findings drawn from the retrieved sources.",
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description:
          "Model-reported confidence, derived from the actual retrieval and synthesis step.",
      },
    },
  },
  endpoints: {
    contract: "GET /api/services/ai-research-v1/contract",
    initiate: "POST order via authenticated app; returns Moove payment URL",
    result: "GET order by id (authenticated) once status === completed",
  },
} as const;

/** The order state machine, enforced server-side. */
export const ORDER_STATES = [
  "awaiting_payment",
  "payment_confirmed",
  "executing",
  "completed",
  "failed",
  "expired",
] as const;
export type OrderStatus = (typeof ORDER_STATES)[number];

/** Legal transitions of the state machine. */
export const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  awaiting_payment: ["payment_confirmed", "expired", "failed"],
  payment_confirmed: ["executing", "failed"],
  executing: ["completed", "failed"],
  completed: [],
  failed: [],
  expired: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}
