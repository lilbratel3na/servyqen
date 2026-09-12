"use node";

/**
 * AI Research service execution — AgentGate V1.
 *
 * Honesty guarantees enforced here:
 *  - The service executes ONLY if the order's PERSISTED status is
 *    payment_confirmed, which only src/convex/moove.ts can set from the real
 *    Moove status endpoint. A frontend click cannot reach this code path.
 *  - A one-shot claim (claimExecutingInternal) ensures exactly one concurrent
 *    run can pass the gate; a crashed run's stale claim is reclaimable.
 *  - Sources come from a real retrieval call to the public arXiv API
 *    (https://export.arxiv.org/api/query). Nothing is invented: every source
 *    is a real arXiv preprint with title, authors, date, abs URL and PDF URL.
 *    If fewer than five real entries come back, the order FAILS — it never
 *    pads with fabricated sources.
 *  - Synthesis is DETERMINISTIC and EXTRACTIVE (src/lib/agentgate-pure.ts):
 *    no language model, no network call, no credentials. Every synthesis
 *    statement and key finding is quoted verbatim from a retrieved abstract,
 *    and confidence is computed from retrieval relevance. Nothing is
 *    generated, paraphrased, or fabricated.
 *  - executedMs is measured wall-clock time: Date.now() immediately before
 *    retrieval begins and immediately after the last source is synthesized.
 *  - The receipt is generated from PERSISTED transaction data (order + result
 *    rows), not from in-memory variables.
 */

import { createHash } from "node:crypto";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { RESEARCH_SERVICE, EXECUTION_CLAIM_STALE_MS } from "../lib/agentgate-contract";
import {
  buildReceipt,
  parseArxivEntries,
  RESULT_PROVIDER,
  synthesizeExtractive,
  type ArxivSource,
} from "../lib/agentgate-pure";

const ARXIV_API = "https://export.arxiv.org/api/query";
const REQUIRED_SOURCES = 5;
const ARXIV_TIMEOUT_MS = 15_000;

/** Retrieve real sources from the arXiv API. Returns raw entries, no padding. */
async function retrieveSources(query: string): Promise<ArxivSource[]> {
  const searchQuery = `all:${encodeURIComponent(query)}`;
  const url = `${ARXIV_API}?search_query=${searchQuery}&start=0&max_results=20&sortBy=relevance`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ARXIV_TIMEOUT_MS);
  let xml: string;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "AgentGate/1.0 (research service)" },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`arXiv API returned HTTP ${res.status}`);
    }
    xml = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const parsed = parseArxivEntries(xml);
  // Exactly five real sources, or an honest failure. Never fabricate.
  if (parsed.length < REQUIRED_SOURCES) {
    throw new Error(
      `arXiv returned only ${parsed.length} verifiable sources for this query; the service requires ${REQUIRED_SOURCES} real sources and will not fabricate the remainder.`,
    );
  }
  return parsed.slice(0, REQUIRED_SOURCES);
}

/** Deterministic SHA-256 over canonical JSON of the result. */
function hashResult(result: unknown): string {
  return createHash("sha256").update(JSON.stringify(result)).digest("hex");
}

export const executeService = internalAction({
  args: { orderId: v.id("orders") },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string }> => {
    try {
      // ONE-SHOT claim: payment_confirmed -> executing only if nobody else
      // claimed it. Two concurrent runs cannot both pass this gate.
      const claim = await ctx.runMutation(internal.orders.claimExecutingInternal, {
        orderId: args.orderId,
        staleClaimMs: EXECUTION_CLAIM_STALE_MS,
      });
      if (!claim.ok) {
        return { ok: false, error: `execution_refused: ${claim.reason}` };
      }

      try {
        const order = await ctx.runQuery(internal.orders.getByIdInternal, {
          orderId: args.orderId,
        });
        if (!order) throw new Error("order_not_found");
        if (order.amount !== RESEARCH_SERVICE.payment.amount) {
          throw new Error("amount_mismatch: order does not match contract price");
        }

        // ---- measured execution window begins ----
        const startedAt = Date.now();

        const sources = await retrieveSources(order.query);
        // Deterministic, credential-free synthesis over the five real abstracts.
        const analysis = synthesizeExtractive(order.query, sources);

        const executedMs = Date.now() - startedAt;
        // ---- measured execution window ends ----

        const result = {
          sources,
          synthesis: analysis.synthesis,
          keyFindings: analysis.keyFindings,
          confidence: analysis.confidence,
          sourcesCount: sources.length,
          generatedAt: new Date().toISOString(),
          measuredMs: executedMs,
          provider: RESULT_PROVIDER,
        };

        if (result.sourcesCount !== REQUIRED_SOURCES) {
          throw new Error("postcondition_violation: sources != 5");
        }

        // Persist result and complete the order with the MEASURED duration.
        await ctx.runMutation(internal.orders.saveResultInternal, {
          orderId: args.orderId,
          query: order.query,
          ...result,
        });
        await ctx.runMutation(internal.orders.transitionInternal, {
          orderId: args.orderId,
          to: "completed",
        });
        await ctx.runMutation(internal.orders.recordExecutionInternal, {
          orderId: args.orderId,
          executedMs,
        });

        // Receipt is built from PERSISTED rows, not in-memory values.
        const persistedOrder = await ctx.runQuery(
          internal.orders.getByIdInternal,
          { orderId: args.orderId },
        );
        const persistedResult = await ctx.runQuery(
          internal.orders.getResearchResultInternal,
          { orderId: args.orderId },
        );
        if (!persistedOrder || !persistedResult) {
          throw new Error("receipt_source_data_missing");
        }

        const receiptResult = {
          sources: persistedResult.sources,
          synthesis: persistedResult.synthesis,
          keyFindings: persistedResult.keyFindings,
          confidence: persistedResult.confidence,
        };

        const receipt = buildReceipt({
          orderId: args.orderId,
          serviceId: persistedOrder.serviceId,
          paymentId: persistedOrder.moovePaymentLinkId ?? "",
          amount: persistedOrder.amount,
          currency: persistedOrder.currency,
          // Honest fallback: if the observed Moove link status was never
          // captured, the receipt says "unknown" — never "completed".
          paymentStatus: persistedOrder.mooveLinkStatus ?? null,
          // On-chain evidence of the settlement transaction, when Moove has
          // reported one for this link.
          transactionUrl: persistedOrder.mooveTransactionUrl ?? null,
          executionStatus: persistedOrder.status,
          executedMs: persistedOrder.executedMs ?? persistedResult.measuredMs,
          slaTargetMs: RESEARCH_SERVICE.execution.slaTargetMs,
          slaNote: RESEARCH_SERVICE.execution.slaNote,
          result: receiptResult,
          resultHash: `sha256:${hashResult(receiptResult)}`,
          createdAt: new Date().toISOString(),
        });

        await ctx.runMutation(internal.orders.saveReceiptInternal, {
          orderId: args.orderId,
          receipt,
        });

        return { ok: true };
      } catch (err) {
        // Failure AFTER the claim: mark the claimed run failed. Failure of
        // this inner block never conflates with the claim losing the race.
        const message =
          err instanceof Error ? err.message : "unknown execution error";
        await ctx.runMutation(internal.orders.transitionInternal, {
          orderId: args.orderId,
          to: "failed",
          error: message,
        }).catch(() => undefined);
        return { ok: false, error: message };
      }
    } catch (err) {
      // Failure BEFORE/WITHIN claiming (e.g. runMutation itself failed).
      // Do NOT mark the order failed: we may have lost a claim race to a
      // concurrent run that is legitimately executing.
      const message =
        err instanceof Error ? err.message : "unknown claim error";
      return { ok: false, error: message };
    }
  },
});
