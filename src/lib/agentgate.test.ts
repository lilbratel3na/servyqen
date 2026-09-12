import { describe, expect, it } from "vitest";

import {
  ALLOWED_TRANSITIONS,
  canTransition,
  MOOVE_LINK_VALIDITY_MS,
  ORDER_EXPIRY_MS,
  RESEARCH_SERVICE,
} from "../lib/agentgate-contract";
import {
  buildReceipt,
  buildSynthesis,
  computeConfidence,
  decodeXmlEntities,
  extractKeyFindings,
  parseArxivEntries,
  queryTerms,
  RESULT_PROVIDER,
  splitSentences,
  synthesizeExtractive,
  type ArxivSource,
} from "../lib/agentgate-pure";

describe("state machine", () => {
  it("allows only the documented forward flow", () => {
    expect(canTransition("awaiting_payment", "payment_confirmed")).toBe(true);
    expect(canTransition("payment_confirmed", "executing")).toBe(true);
    expect(canTransition("executing", "completed")).toBe(true);
    expect(canTransition("executing", "failed")).toBe(true);
    expect(canTransition("payment_confirmed", "failed")).toBe(true);
    expect(canTransition("awaiting_payment", "expired")).toBe(true);
    // Recovery: a late genuine payment after our own expiry must be honored.
    expect(canTransition("expired", "payment_confirmed")).toBe(true);
  });

  it("rejects every skip transition", () => {
    expect(canTransition("awaiting_payment", "executing")).toBe(false);
    expect(canTransition("awaiting_payment", "completed")).toBe(false);
    expect(canTransition("payment_confirmed", "completed")).toBe(false);
    expect(canTransition("expired", "completed")).toBe(false);
    expect(canTransition("expired", "executing")).toBe(false);
    expect(canTransition("failed", "executing")).toBe(false);
  });

  it("has no outgoing transitions from terminal states", () => {
    for (const terminal of ["completed", "failed"] as const) {
      expect(ALLOWED_TRANSITIONS[terminal]).toEqual([]);
      for (const to of Object.keys(ALLOWED_TRANSITIONS)) {
        expect(canTransition(terminal, to as keyof typeof ALLOWED_TRANSITIONS)).toBe(
          terminal === to && false,
        );
      }
    }
  });

  it("never allows executing -> payment_confirmed (no re-confirmation)", () => {
    expect(canTransition("executing", "payment_confirmed")).toBe(false);
  });
});

describe("money-safety timing", () => {
  it("the Moove link outlives our order payment window", () => {
    expect(MOOVE_LINK_VALIDITY_MS).toBeGreaterThan(ORDER_EXPIRY_MS);
  });

  it("keeps the contract price and required source count honest", () => {
    expect(RESEARCH_SERVICE.payment.amount).toBe("1");
    expect(RESEARCH_SERVICE.payment.currency).toBe("USDC");
    expect(RESEARCH_SERVICE.output.properties.sources.minItems).toBe(5);
    expect(RESEARCH_SERVICE.output.properties.sources.maxItems).toBe(5);
    expect(RESEARCH_SERVICE.execution.slaTargetMs).toBe(5000);
    expect(RESEARCH_SERVICE.execution.slaNote).toContain("TARGET");
  });

  it("describes confidence honestly as computed, never model-reported", () => {
    const description = RESEARCH_SERVICE.output.properties.confidence.description;
    expect(description).toContain("not model-reported");
    expect(description).toContain("fraction");
  });
});

describe("decodeXmlEntities", () => {
  it("decodes the standard entities and leaves unknown ones intact", () => {
    expect(decodeXmlEntities("&lt;b&gt; &amp; &quot;q&quot; &apos;")).toBe(
      '<b> & "q" \'',
    );
    expect(decodeXmlEntities("&unknown; &#39;")).toBe("&unknown; '");
  });
});

describe("parseArxivEntries", () => {
  const entry = (
    overrides: Partial<Record<"id" | "title" | "published" | "summary" | "name" | "pdf", string>>,
  ) => {
    const id = overrides.id ?? "http://arxiv.org/abs/2401.00001v1";
    const title = overrides.title ?? "A Real Paper";
    const published = overrides.published ?? "2024-01-15T00:00:00Z";
    const summary = overrides.summary ?? "An abstract.";
    const name = overrides.name ?? "Ada Lovelace";
    const pdf = overrides.pdf ?? "http://arxiv.org/pdf/2401.00001v1";
    return `<entry><id>${id}</id><title>${title}</title><published>${published}</published><summary>${summary}</summary><author><name>${name}</name></author><link href="${pdf}" type="application/pdf" rel="related"/></entry>`;
  };

  it("parses well-formed entries with title, authors, dates, and URLs", () => {
    const sources = parseArxivEntries(
      `<feed>${entry({})}${entry({ id: "http://arxiv.org/abs/2402.00002v1", title: "Second &amp; Paper" })}</feed>`,
    );
    expect(sources).toHaveLength(2);
    expect(sources[0]).toEqual({
      title: "A Real Paper",
      authors: ["Ada Lovelace"],
      published: "2024-01-15",
      absUrl: "http://arxiv.org/abs/2401.00001v1",
      pdfUrl: "http://arxiv.org/pdf/2401.00001v1",
      summary: "An abstract.",
    });
    expect(sources[1].title).toBe("Second & Paper");
  });

  it("skips incomplete entries instead of padding with fabrications", () => {
    const incomplete = `<entry><id>http://arxiv.org/abs/x</id><title>T</title></entry>`;
    const sources = parseArxivEntries(`<feed>${entry({})}${incomplete}</feed>`);
    expect(sources).toHaveLength(1);
  });

  it("returns an empty array for no entries", () => {
    expect(parseArxivEntries("<feed></feed>")).toEqual([]);
  });

  it("collapses whitespace and decodes entities inside fields", () => {
    const xml = entry({
      title: "Line1\n   Line2 &amp; More",
      summary: "Sp  aces\t\tand &quot;quotes&quot;",
    });
    const [source] = parseArxivEntries(xml);
    expect(source.title).toBe("Line1 Line2 & More");
    expect(source.summary).toBe('Sp aces and "quotes"');
  });

  it("falls back to the abstract URL when no PDF link exists", () => {
    const xml = `<entry><id>http://arxiv.org/abs/2401.00001v1</id><title>T</title><published>2024-01-15T00:00:00Z</published><summary>S</summary><author><name>A</name></author></entry>`;
    const [source] = parseArxivEntries(xml);
    expect(source.pdfUrl).toBe(source.absUrl);
  });
});

describe("deterministic extractive synthesis", () => {
  const source = (overrides: Partial<ArxivSource> & { title: string; summary: string }): ArxivSource => ({
    authors: ["A. Author"],
    published: "2024-01-15",
    absUrl: `http://arxiv.org/abs/${overrides.title.toLowerCase().replace(/\W+/g, "-")}`,
    pdfUrl: "http://arxiv.org/pdf/x",
    ...overrides,
  });

  const sources: ArxivSource[] = [
    source({
      title: "Attention Is All You Need",
      summary:
        "We propose the Transformer, a sequence model built on attention. Experiments show strong results on translation.",
    }),
    source({
      title: "Scaling Laws for Neural Language Models",
      summary:
        "We study empirical scaling laws for language model performance on the cross-entropy loss.",
    }),
    source({
      title: "Random unrelated paper",
      summary: "This paper is about bird migration patterns across continents.",
    }),
  ];

  it("extracts only meaningful query terms", () => {
    expect(queryTerms("What are scaling laws in language models? the of")).toEqual([
      "scaling",
      "laws",
      "language",
      "models",
    ]);
  });

  it("splits text into sentences and preserves content", () => {
    expect(splitSentences("One. Two! Three? Four")).toEqual([
      "One.",
      "Two!",
      "Three?",
      "Four",
    ]);
  });

  it("computes confidence as the fraction of topically matching sources", () => {
    // Terms: ["models", "translation"]. Source 1 mentions "translation",
    // source 2 mentions "Models" in its title; the bird paper matches neither.
    expect(computeConfidence("models translation", sources)).toBe(2 / 3);
    // "models" (plural) does not appear in source 1's singular "model" —
    // substring matching is exact, so only the scaling-laws paper matches.
    expect(computeConfidence("language models", sources)).toBe(1 / 3);
  });

  it("returns confidence 0 with no sources", () => {
    expect(computeConfidence("anything", [])).toBe(0);
  });

  it("keeps confidence within [0,1] for any query", () => {
    expect(computeConfidence("zzz nonexistent terms", sources)).toBe(0);
    expect(computeConfidence("paper", sources)).toBeLessThanOrEqual(1);
  });

  it("emits one verbatim finding per source, attributed to the real title", () => {
    const findings = extractKeyFindings("language models", sources);
    expect(findings).toHaveLength(3);
    for (let i = 0; i < sources.length; i++) {
      expect(findings[i].startsWith(`[${sources[i]!.title}] `)).toBe(true);
      // Every finding excerpt must be a substring of the actual abstract.
      const excerpt = findings[i]!.slice(sources[i]!.title.length + 3);
      expect(sources[i]!.summary.includes(excerpt)).toBe(true);
    }
  });

  it("picks the most query-relevant sentence for the finding", () => {
    const [first] = extractKeyFindings("translation", sources);
    expect(first).toContain("strong results on translation");
  });

  it("falls back to the first sentence when nothing matches the query", () => {
    const findings = extractKeyFindings("quantum chromodynamics", sources);
    expect(findings[2]).toContain("bird migration patterns");
  });

  it("builds a synthesis that quotes abstracts verbatim and discloses no-LLM", () => {
    const synthesis = buildSynthesis("language models", sources);
    expect(synthesis).toContain("no language model");
    expect(synthesis).toContain("We propose the Transformer, a sequence model built on attention.");
    expect(synthesis).toContain("(A. Author, 2024-01-15)");
  });

  it("produces a complete, consistent analysis payload", () => {
    const analysis = synthesizeExtractive("language models", sources);
    expect(analysis.keyFindings).toHaveLength(sources.length);
    expect(analysis.confidence).toBe(computeConfidence("language models", sources));
    expect(analysis.synthesis.length).toBeGreaterThan(0);
  });

  it("labels the result provider as arXiv + extractive with no LLM", () => {
    expect(RESULT_PROVIDER).toContain("arxiv-api");
    expect(RESULT_PROVIDER).toContain("no LLM");
  });

  it("is deterministic: identical inputs produce identical output", () => {
    expect(synthesizeExtractive("language models", sources)).toEqual(
      synthesizeExtractive("language models", sources),
    );
  });
});

describe("buildReceipt", () => {
  const base = {
    orderId: "o123",
    serviceId: "ai-research-v1",
    paymentId: "pay-1",
    amount: "1",
    currency: "USDC",
    paymentStatus: "completed" as string | null,
    transactionUrl: "https://basescan.org/tx/0xabc" as string | null,
    executionStatus: "completed",
    executedMs: 4210,
    slaTargetMs: 5000,
    slaNote: "target",
    result: {
      sources: [] as ArxivSource[],
      synthesis: "S",
      keyFindings: ["a"],
      confidence: 0.7,
    },
    resultHash: "sha256:abc",
    createdAt: "2026-09-12T00:00:00.000Z",
  };

  it("passes through known payment status and all persisted fields", () => {
    const receipt = buildReceipt(base) as Record<string, unknown>;
    expect(receipt["paymentStatus"]).toBe("completed");
    expect(receipt["transactionUrl"]).toBe("https://basescan.org/tx/0xabc");
    expect(receipt["orderId"]).toBe("o123");
    expect(receipt["executedMs"]).toBe(4210);
    expect(receipt["resultHash"]).toBe("sha256:abc");
  });

  it("never overstates payment: null status becomes 'unknown'", () => {
    const receipt = buildReceipt({ ...base, paymentStatus: null });
    expect(receipt["paymentStatus"]).toBe("unknown");
  });

  it("keeps tx evidence nullable, honestly absent when unreported", () => {
    const receipt = buildReceipt({ ...base, transactionUrl: null });
    expect(receipt["transactionUrl"]).toBeNull();
  });
});
