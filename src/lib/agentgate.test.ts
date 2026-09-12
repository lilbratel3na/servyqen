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
  decodeXmlEntities,
  extractModelJson,
  parseArxivEntries,
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

describe("extractModelJson", () => {
  it("parses a clean JSON object", () => {
    const analysis = extractModelJson(
      '{"synthesis":"S","keyFindings":["a","b"],"confidence":0.8}',
    );
    expect(analysis).toEqual({
      synthesis: "S",
      keyFindings: ["a", "b"],
      confidence: 0.8,
    });
  });

  it("parses JSON wrapped in code fences or prose", () => {
    const fenced = '```json\n{"synthesis":"S","keyFindings":["f"],"confidence":0.4}\n```';
    expect(extractModelJson(fenced)?.confidence).toBe(0.4);
    const prose = 'Here is the result: {"synthesis":"S","keyFindings":["f"],"confidence":0.9} hope it helps';
    expect(extractModelJson(prose)?.synthesis).toBe("S");
  });

  it("clamps out-of-range confidence into [0,1]", () => {
    expect(extractModelJson('{"synthesis":"S","keyFindings":["f"],"confidence":5}')?.confidence).toBe(1);
    expect(extractModelJson('{"synthesis":"S","keyFindings":["f"],"confidence":-2}')?.confidence).toBe(0);
  });

  it("defaults missing confidence to a conservative 0.5", () => {
    expect(extractModelJson('{"synthesis":"S","keyFindings":["f"]}')?.confidence).toBe(0.5);
  });

  it("rejects malformed or empty shapes", () => {
    expect(extractModelJson("no json here")).toBeNull();
    expect(extractModelJson('{"keyFindings":["f"]}')).toBeNull(); // no synthesis
    expect(extractModelJson('{"synthesis":"S"}')).toBeNull(); // no findings
    expect(extractModelJson('{"synthesis":"S","keyFindings":[1,2]}')).toBeNull();
    expect(extractModelJson('{"synthesis":"","keyFindings":["f"]}')).toBeNull();
    expect(extractModelJson('{"synthesis":"S","keyFindings":["f"],')).toBeNull(); // invalid JSON
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
    expect(receipt["orderId"]).toBe("o123");
    expect(receipt["executedMs"]).toBe(4210);
    expect(receipt["resultHash"]).toBe("sha256:abc");
  });

  it("never overstates payment: null status becomes 'unknown'", () => {
    const receipt = buildReceipt({ ...base, paymentStatus: null });
    expect(receipt["paymentStatus"]).toBe("unknown");
  });
});
