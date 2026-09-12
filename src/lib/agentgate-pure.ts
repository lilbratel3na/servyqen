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

/**
 * Deterministic extractive analysis — no language model, no network, no
 * credentials. Every output sentence is quoted VERBATIM from a retrieved
 * abstract; confidence is computed from measured retrieval relevance.
 * Nothing is invented, paraphrased, or padded.
 */

/** Provider label persisted with every research result. */
export const RESULT_PROVIDER = "arxiv-api + extractive-synthesis (no LLM)";

/** Analysis payload produced by the extractive synthesis step. */
export interface ExtractiveAnalysis {
  synthesis: string;
  keyFindings: string[];
  confidence: number;
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has",
  "have", "how", "in", "is", "it", "of", "on", "or", "that", "the", "to",
  "was", "what", "when", "where", "which", "who", "why", "will", "with",
]);

/** Meaningful lowercase terms of a query (stop words and short tokens removed). */
export function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

/** Split text into sentences (original characters preserved). */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function termHits(text: string, terms: string[]): number {
  const lower = text.toLowerCase();
  return terms.reduce((acc, t) => acc + (lower.includes(t) ? 1 : 0), 0);
}

/**
 * Confidence = the fraction of the given sources whose title or abstract
 * contains at least one meaningful query term. Deterministic, in [0,1].
 */
export function computeConfidence(
  query: string,
  sources: ArxivSource[],
): number {
  if (sources.length === 0) return 0;
  const terms = queryTerms(query);
  const relevant = sources.filter(
    (s) => termHits(`${s.title} ${s.summary}`, terms) > 0,
  ).length;
  return relevant / sources.length;
}

/**
 * One verbatim finding per source: the abstract sentence most relevant to
 * the query (first sentence as an honest fallback when none match),
 * attributed to the real paper title.
 */
export function extractKeyFindings(
  query: string,
  sources: ArxivSource[],
): string[] {
  const terms = queryTerms(query);
  return sources.map((source) => {
    const sentences = splitSentences(source.summary);
    let best = sentences[0] ?? source.summary;
    let bestHits = -1;
    for (const sentence of sentences) {
      const hits = termHits(sentence, terms);
      if (hits > bestHits) {
        bestHits = hits;
        best = sentence;
      }
    }
    return `[${source.title}] ${best}`;
  });
}

/**
 * Extractive synthesis: verbatim lead sentence of each abstract, in
 * retrieval order, with explicit "no language model" framing.
 */
export function buildSynthesis(query: string, sources: ArxivSource[]): string {
  const lines = sources.map((s, i) => {
    const lead = splitSentences(s.summary)[0] ?? s.summary;
    const authors =
      s.authors.slice(0, 3).join(", ") + (s.authors.length > 3 ? ", et al." : "");
    return `[${i + 1}] ${lead} (${authors}, ${s.published})`;
  });
  return (
    `Extractive synthesis for "${query}" from ${sources.length} arXiv sources ` +
    "(deterministic, no language model; every statement is quoted verbatim " +
    "from a source abstract): " +
    lines.join(" ")
  );
}

/** Combine the extractive pieces into the persisted analysis payload. */
export function synthesizeExtractive(
  query: string,
  sources: ArxivSource[],
): ExtractiveAnalysis {
  return {
    synthesis: buildSynthesis(query, sources),
    keyFindings: extractKeyFindings(query, sources),
    confidence: computeConfidence(query, sources),
  };
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
