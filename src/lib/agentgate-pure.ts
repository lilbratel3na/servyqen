/**
 * Pure, side-effect-free helpers for the AgentGate research service.
 *
 * This module deliberately has no imports and performs no I/O so it can be
 * unit-tested directly and reused by both the Convex actions and the test
 * suite without any environment-specific setup.
 */

/** One verifiable academic source (an arXiv preprint). */
export interface ArxivSource {
  title: string;
  authors: string[];
  published: string;
  absUrl: string;
  pdfUrl: string;
  summary: string;
}

export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Shared whitespace-collapsing cleanup for parsed XML text. */
export function clean(s: string | undefined): string {
  return decodeXmlEntities(s ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Minimal Atom-XML extraction for arXiv entries (documented public API).
 * Returns entries only when id/title/published/summary/>=1 author are all
 * present; partial entries are skipped, never padded.
 */
export function parseArxivEntries(xml: string): ArxivSource[] {
  const sources: ArxivSource[] = [];
  const entryBlocks = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  for (const block of entryBlocks) {
    const id = clean(block.match(/<id>([\s\S]*?)<\/id>/)?.[1]);
    const title = clean(block.match(/<title>([\s\S]*?)<\/title>/)?.[1]);
    const published = clean(
      block.match(/<published>([\s\S]*?)<\/published>/)?.[1],
    );
    const summary = clean(block.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]);
    const authors = [...block.matchAll(/<name>([\s\S]*?)<\/name>/g)]
      .map((m) => clean(m[1]))
      .filter(Boolean);
    const pdfMatch = block.match(/<link[^>]*href="([^"]+)"[^>]*\/?>/g)?.find(
      (tag) => tag.includes('type="application/pdf"'),
    );
    const pdfUrl = clean(pdfMatch?.match(/href="([^"]+)"/)?.[1]);

    if (
      id.length > 0 &&
      title.length > 0 &&
      published.length > 0 &&
      summary.length > 0 &&
      authors.length > 0
    ) {
      sources.push({
        title,
        authors,
        published: published.slice(0, 10),
        absUrl: id,
        pdfUrl: pdfUrl.length > 0 ? pdfUrl : id,
        summary,
      });
    }
  }
  return sources;
}

/** Model analysis payload returned by the synthesis step. */
export interface ModelAnalysis {
  synthesis: string;
  keyFindings: string[];
  confidence: number;
}

/**
 * Extract {synthesis, keyFindings, confidence} from model text that may be
 * wrapped in code fences or prose. Returns null when no parseable,
 * well-shaped object is present — callers treat null as an honest failure.
 */
export function extractModelJson(text: string): ModelAnalysis | null {
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
    if (typeof raw.synthesis !== "string" || raw.synthesis.length === 0) {
      return null;
    }
    const keyFindings = Array.isArray(raw.keyFindings)
      ? raw.keyFindings.filter((f): f is string => typeof f === "string" && f.length > 0)
      : [];
    if (keyFindings.length === 0) return null;
    const confidence =
      typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
        ? Math.min(1, Math.max(0, raw.confidence))
        : 0.5; // conservative neutral when the model reports none
    return { synthesis: raw.synthesis, keyFindings, confidence };
  } catch {
    return null;
  }
}

/**
 * Build the machine-readable receipt from PERSISTED transaction data only.
 * paymentStatus falls back to "unknown" — never "completed" — when the
 * observed Moove link status was not captured, so the receipt cannot
 * overstate payment evidence.
 */
export function buildReceipt(input: {
  orderId: string;
  serviceId: string;
  paymentId: string;
  amount: string;
  currency: string;
  paymentStatus: string | null;
  transactionUrl: string | null;
  executionStatus: string;
  executedMs: number;
  slaTargetMs: number;
  slaNote: string;
  result: {
    sources: ArxivSource[];
    synthesis: string;
    keyFindings: string[];
    confidence: number;
  };
  resultHash: string;
  createdAt: string;
}): Record<string, unknown> {
  return {
    orderId: input.orderId,
    serviceId: input.serviceId,
    paymentId: input.paymentId,
    amount: input.amount,
    currency: input.currency,
    paymentStatus: input.paymentStatus ?? "unknown",
    transactionUrl: input.transactionUrl ?? null,
    executionStatus: input.executionStatus,
    executedMs: input.executedMs,
    slaTargetMs: input.slaTargetMs,
    slaNote: input.slaNote,
    result: input.result,
    resultHash: input.resultHash,
    createdAt: input.createdAt,
  };
}
