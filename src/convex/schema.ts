import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove
    }).index("email", ["email"]), // index for the email. do not remove or modify

    // ---------------------------------------------------------------
    // AgentGate V1: machine-to-service commerce layer
    // ---------------------------------------------------------------

    // A purchase of a service. The machine-readable contract itself lives in
    // src/lib/agentgate-contract.ts (single source of truth); orders reference it by id.
    orders: defineTable({
      // Convex-auth user for dashboard orders; machine orders created via
      // POST /api/orders have no user and rely on their per-order capability
      // token (orderTokenHash) for access instead.
      userId: v.optional(v.id("users")),
      serviceId: v.string(),
      query: v.string(),
      amount: v.string(), // e.g. "1" — denominated in the settlement token
      currency: v.string(), // e.g. "USDC"
      // awaiting_payment -> payment_confirmed -> executing -> completed
      // with failed / expired side states. failed_retriable = a PAID order
      // whose execution failed transiently (timeout/network/provider); it
      // may re-enter executing via the one-shot claim without paying again.
      status: v.string(),
      // "transient" | "permanent" when status is failed/failed_retriable.
      // Transient execution failures are retryable; permanent contract
      // failures (insufficient verifiable sources, integrity errors) are not.
      failureKind: v.optional(v.union(v.literal("transient"), v.literal("permanent"))),
      moovePaymentLinkId: v.optional(v.string()),
      moovePaymentUrl: v.optional(v.string()),
      mooveLinkStatus: v.optional(v.string()), // active | completed | inactive (as reported by Moove)
      mooveTransactionUrl: v.optional(v.string()),
      // Machine API access: SHA-256 hash of the one-time order capability
      // token returned exactly once by POST /api/orders. The raw token is
      // never stored.
      orderTokenHash: v.optional(v.string()),
      error: v.optional(v.string()),
      // Number of genuine execution attempts (claimed runs). Incremented by
      // claimExecutingInternal; exposed in the machine-readable order view.
      executionAttempts: v.optional(v.number()),
      createdAt: v.number(),
      updatedAt: v.number(),
      paymentConfirmedAt: v.optional(v.number()),
      executionStartedAt: v.optional(v.number()),
      completedAt: v.optional(v.number()),
      executedMs: v.optional(v.number()), // measured wall-clock execution time
    })
      .index("by_userId", ["userId"])
      .index("by_orderId_status", ["serviceId", "status"]),

    // The research result produced by the service, if and only if execution ran.
    researchResults: defineTable({
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
      measuredMs: v.number(), // same wall-clock measurement as orders.executedMs
      provider: v.string(),
    }).index("by_orderId", ["orderId"]),

    // Machine-readable receipt generated from persisted order + result data.
    receipts: defineTable({
      orderId: v.id("orders"),
      receipt: v.any(),
      createdAt: v.number(),
    }).index("by_orderId", ["orderId"]),
  },
  {
    schemaValidation: false,
  },
);

export default schema;
