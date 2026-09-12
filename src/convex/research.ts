"use node";

/**
 * AI Research service execution — AgentGate V1.
 *
 * Honesty guarantees enforced here:
 *  - The service executes ONLY if the order's PERSISTED status is
 *    payment_confirmed, which only src/convex/moove.ts can set from the real
 *    Moove status endpoint. A frontend click cannot reach this code path.
 *  - Sources come from a real retrieval call to the public arXiv API
 *    (https://export.arxiv.org/api/query). Nothing is invented: every source
 *    is a real arXiv preprint with title, authors, date, abs URL and PDF URL.
 *    If fewer than five real entries come back, the order FAILS — it never
 *    pads with fabricated sources.
 *  - executedMs is measured wall-clock time: Date.now() immediately before
 *    retrieval begins and immediately after the last source is synthesized.
 *  - The receipt is generated from PERSISTED transaction data (order + result
 *    rows), not from in-memory variables.
 */

import { createHash } from "node:crypto";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { vly } from "../lib/vly-integrations";
import { RESEARCH_SERVICE } from "../lib/agentgate-contract";

const ARXIV_API = "https://export.arxiv.org/api/query";
const REQUIRED_SOURCES = 5;

interface ArxivSource {
  title: string;
  authors: string[];
  published: string;
  absUrl: string;
  pdfUrl: string;
  summary: string;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function clean(s: string | undefined): string {
  return decodeXmlEntities(s ?? "").replace(/\s+/g, " ").trim();
}

/** Minimal Atom-XML extraction for arXiv entries (documented public API). */
function parseArxivEntries(xml: string): ArxivSource[] {
  const sources: ArxivSource[] = [];
  const entryBlocks = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  for (const block of entryBlocks) {
    const id = clean(block.match(/<id>([\s\S]*?)<\/id>/)?.[1]);
    const title = clean(block.match(/<title>([\s\S]*?)<\/title>/)?.[1]);
    const published = clean(block.match(/<published>([\s\S]*?)<\/published>/)?.[1]);
    const summary = clean(block.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]);
    const authors = [...block.matchAll(/<name>([\s\S]*?)<\/name>/g)]
      .map((m) => clean(m[1]))
      .filter(Boolean);
    const pdfMatch = block.match(/<link[^>]*href="([^"]+)"[^>]*\/?>/g)?.find(
      (tag) => tag.includes('type="application/pdf"'),
    );
    const pdfUrl = clean(pdfMatch?.match(/href="([^"]+)"/)?.[1]);

    if (id && title && published && summary && authors.length > 0) {
      sources.push({
        title,
        authors,
        published: published.slice(0, 10),
        absUrl: id,
        pdfUrl: pdfUrl || id,
        summary,
      });
    }
  }
  return sources;
}

/** Retrieve real sources from the arXiv API. Returns raw entries, no padding. */
async function retrieveSources(query: string): Promise<ArxivSource[]> {
  const searchQuery = `all:${encodeURIComponent(query)}`;
  const url = `${ARXIV_API}?search_query=${searchQuery}&start=0&max_results=20&sortBy=relevance`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
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

interface ModelAnalysis {
  synthesis: string;
  keyFindings: string[];
  confidence: number;
}

function extractJson(text: string): ModelAnalysis | null {
  const withoutFences = text.replace(/```(?:json)?/g, "").trim();
  const start = withoutFences.indexOf("{");
  const end = withoutFences.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const raw = JSON.parse(withoutFences.slice(start, end + 1)) as {
      synthesis?: unknown;
      keyFindings?: unknown;
      confidence?: unknown;
    };
    if (typeof raw.synthesis !== "string") return null;
    const keyFindings = Array.isArray(raw.keyFindings)
      ? raw.keyFindings.filter((f): f is string => typeof f === "string")
      : [];
    if (keyFindings.length === 0) return null;
    const confidence =
      typeof raw.confidence === "number"
        ? Math.min(1, Math.max(0, raw.confidence))
        : 0.5; // conservative neutral when the model reports none
    return { synthesis: raw.synthesis, keyFindings, confidence };
  } catch {
    return null;
  }
}

/** Synthesize with the built-in vly completions gateway (AI models only). */
async function synthesize(
  query: string,
  sources: ArxivSource[],
): Promise<ModelAnalysis> {
  const abstracts = sources
    .map(
      (s, i) =>
        `[${i + 1}] "${s.title}" — ${s.authors.join(", ")} (${s.published})\nAbstract: ${s.summary}`,
    )
    .join("\n\n");

  const result = await vly.ai.completion({
    model: "gpt-4o-mini",
    temperature: 0.2,
    maxTokens: 900,
    messages: [
      {
        role: "system",
        content:
          "You are a research synthesis engine. You receive a research query and exactly five real arXiv abstracts. Synthesize ONLY what those abstracts support — never invent facts, claims, or sources. Respond with strict JSON of shape {\"synthesis\": string, \"keyFindings\": string[], \"confidence\": number} where confidence is in [0,1] and reflects how well the five abstracts actually answer the query.",
      },
      {
        role: "user",
        content: `Research query: ${query}\n\nThe five retrieved sources:\n\n${abstracts}`,
      },
    ],
  });

  if (!result.success || !result.data?.choices?.[0]?.message?.content) {
    throw new Error(
      `vly completions gateway failed: ${result.error ?? "empty response"}`,
    );
  }
  const parsed = extractJson(result.data.choices[0].message.content);
  if (!parsed) {
    throw new Error("Model response was not parseable as the required JSON shape");
  }
  return parsed;
}

/** Deterministic SHA-256 over canonical JSON of the result. */
function hashResult(result: unknown): string {
  return createHash("sha256").update(JSON.stringify(result)).digest("hex");
}

export const executeService = internalAction({
  args: { orderId: v.id("orders") },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string }> => {
    try {
      const order = await ctx.runQuery(internal.orders.getByIdInternal, {
        orderId: args.orderId,
      });
      if (!order) throw new Error("order_not_found");

      // HARD GATE: only a genuinely, server-side confirmed order may execute.
      if (order.status !== "payment_confirmed") {
        throw new Error(
          `execution_refused: order status is '${order.status}', not 'payment_confirmed'`,
        );
      }
      if (order.amount !== RESEARCH_SERVICE.payment.amount) {
        throw new Error("amount_mismatch: order does not match contract price");
      }

      await ctx.runMutation(internal.orders.transitionInternal, {
        orderId: args.orderId,
        to: "executing",
      });

      // ---- measured execution window begins ----
      const startedAt = Date.now();

      const sources = await retrieveSources(order.query);
      const analysis = await synthesize(order.query, sources);

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
        provider: "arxiv-api + vly-ai-gateway",
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

      const receipt = {
        orderId: args.orderId,
        serviceId: persistedOrder.serviceId,
        paymentId: persistedOrder.moovePaymentLinkId,
        amount: persistedOrder.amount,
        currency: persistedOrder.currency,
        paymentStatus: persistedOrder.mooveLinkStatus ?? "completed",
        executionStatus: persistedOrder.status,
        executedMs: persistedOrder.executedMs ?? persistedResult.measuredMs,
        slaTargetMs: RESEARCH_SERVICE.execution.slaTargetMs,
        slaNote: RESEARCH_SERVICE.execution.slaNote,
        result: receiptResult,
        resultHash: `sha256:${hashResult(receiptResult)}`,
        createdAt: new Date().toISOString(),
      };

      await ctx.runMutation(internal.orders.saveReceiptInternal, {
        orderId: args.orderId,
        receipt,
      });

      return { ok: true };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "unknown execution error";
      await ctx.runMutation(internal.orders.transitionInternal, {
        orderId: args.orderId,
        to: "failed",
        error: message,
      }).catch(() => undefined);
      return { ok: false, error: message };
    }
  },
});
