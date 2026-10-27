import { describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import {
  applyVerdict,
  buildVerificationUserParts,
  parseVerdict,
  verifyDefects,
  type AuditOutcome,
} from "../verify";
import type { Defect } from "../types";

const visual = (
  id: string,
  severity: Defect["severity"] = "HIGH",
  t = 10,
): Defect => ({
  id,
  assetId: `${id}-asset`,
  assetCategory: "insulator",
  severity,
  title: `title-${id}`,
  description: "detail",
  frameTimestamp: t,
  recommendedAction: "fix it",
  estimatedUrgency: "Monitor",
  evidenceSource: "visual",
  evidenceFrameIndex: 0,
  observation: `rust at ${id}`,
  frameCapture: "AAA",
});

const voiceOnly = (id: string): Defect => ({
  id,
  assetId: `${id}-asset`,
  assetCategory: "insulator",
  severity: "LOW",
  title: `title-${id}`,
  description: "detail",
  frameTimestamp: 5,
  recommendedAction: "fix it",
  estimatedUrgency: "Monitor",
  evidenceSource: "voice",
});

const frames = [{ timestamp: 10, base64: "AAA" }];

const keepPayload = (reason = "clear corrosion visible"): string =>
  JSON.stringify({ verdict: "keep", reason });

// Records titles seen per create() call; behaviour configurable per test.
function mockClient(
  impl: (callIndex: number, text: string) => Promise<string>,
) {
  const seen: string[] = [];
  let calls = 0;
  const create = vi.fn(async (args: unknown) => {
    const idx = calls++;
    const parts = (args as { messages: { content: { text?: string }[] }[] }).messages[1].content;
    const text = parts.map((p) => p.text ?? "").join("\n");
    const title = /Defect: (.+)/.exec(text)?.[1] ?? "?";
    seen.push(title);
    return { choices: [{ message: { content: await impl(idx, text) } }] };
  });
  return { client: { chat: { completions: { create } } } as unknown as OpenAI, create, seen };
}

const baseOpts = (client: OpenAI) => ({
  frames,
  videoPath: null,
  sessionId: "s1",
  client,
  model: "test-model",
});

describe("parseVerdict", () => {
  it("accepts bare JSON", () => {
    expect(parseVerdict(keepPayload())).toEqual({ verdict: "keep", reason: "clear corrosion visible" });
  });

  it("accepts ```json fenced blocks", () => {
    expect(parseVerdict('```json\n{"verdict":"downgrade","reason":"blurry"}```')).toEqual({
      verdict: "downgrade",
      reason: "blurry",
    });
  });

  it("accepts prose-wrapped JSON", () => {
    const raw = 'Here is my review: {"verdict": "drop", "reason": "healthy asset"} — done.';
    expect(parseVerdict(raw)).toEqual({ verdict: "drop", reason: "healthy asset" });
  });

  it("throws on garbage, off-schema verdicts, and missing reasons", () => {
    expect(() => parseVerdict("no json here")).toThrow();
    expect(() => parseVerdict("")).toThrow();
    expect(() => parseVerdict(JSON.stringify({ verdict: "maybe", reason: "x" }))).toThrow();
    expect(() => parseVerdict(JSON.stringify({ verdict: "keep" }))).toThrow();
    expect(() => parseVerdict(JSON.stringify({ verdict: "keep", reason: "  " }))).toThrow();
    expect(() => parseVerdict(JSON.stringify({ verdict: "keep", reason: 42 }))).toThrow();
  });
});

describe("buildVerificationUserParts", () => {
  it("packs claim context plus the cited image", () => {
    const parts = buildVerificationUserParts(visual("v1"), "QQQ");
    expect(parts).toHaveLength(2);
    expect(parts[0].type).toBe("text");
    const text = (parts[0] as { text: string }).text;
    expect(text).toContain("insulator");
    expect(text).toContain("title-v1");
    expect(text).toContain("rust at v1");
    expect(text).toContain("10.00s");
    expect(parts[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64,QQQ" },
    });
  });
});

describe("applyVerdict", () => {
  it("keep annotates and leaves evidence fields alone", () => {
    const d = visual("k");
    const out = applyVerdict(d, { verdict: "keep", reason: "confirmed" });
    expect(out).not.toBeNull();
    expect(out?.verification).toEqual({ verdict: "keep", reason: "confirmed" });
    expect(out?.evidenceSource).toBe("visual");
    expect(out?.observation).toBe("rust at k");
    expect(out?.frameCapture).toBe("AAA");
  });

  it("downgrade strips visual claims and keeps the finding as voice", () => {
    const out = applyVerdict(visual("d"), { verdict: "downgrade", reason: "unclear" });
    expect(out).not.toBeNull();
    expect(out?.evidenceSource).toBe("voice");
    expect(out?.observation).toBeUndefined();
    expect(out?.evidenceFrameIndex).toBeUndefined();
    expect(out?.frameCapture).toBeUndefined();
    expect(out?.verification).toEqual({ verdict: "downgrade", reason: "unclear" });
  });

  it("drop removes the defect", () => {
    expect(applyVerdict(visual("x"), { verdict: "drop", reason: "healthy" })).toBeNull();
  });
});

describe("verifyDefects", () => {
  it("skips voice-only defects without calling the model", async () => {
    const { client, create } = mockClient(async () => keepPayload());
    const out = await verifyDefects([voiceOnly("a"), voiceOnly("b"), visual("v")], baseOpts(client));
    expect(create).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(3);
    expect(out.find((d) => d.id === "a")?.verification).toBeUndefined();
    expect(out.find((d) => d.id === "v")?.verification?.verdict).toBe("keep");
  });

  it("respects cap and verifies CRITICAL first regardless of input order", async () => {
    const { client, seen } = mockClient(async () => keepPayload());
    const input = [
      visual("low-1", "LOW"),
      visual("med-1", "MEDIUM"),
      visual("crit-1", "CRITICAL"),
      visual("high-1", "HIGH"),
    ];
    const out = await verifyDefects(input, { ...baseOpts(client), cap: 3 });
    expect(seen).toEqual(["title-crit-1", "title-high-1", "title-med-1"]);
    expect(out).toHaveLength(4); // nothing dropped
    // Output preserves input order (route sorts later); the verified SET is what matters.
    expect(out.filter((d) => d.verification).map((d) => d.id).sort()).toEqual([
      "crit-1",
      "high-1",
      "med-1",
    ]);
  });

  it("never exceeds 8 calls per report by default", async () => {
    const { client, create } = mockClient(async () => keepPayload());
    const input = Array.from({ length: 12 }, (_, i) => visual(`v${i}`, "HIGH", i));
    const out = await verifyDefects(input, baseOpts(client));
    expect(create).toHaveBeenCalledTimes(8);
    expect(out).toHaveLength(12);
  });

  it("API failure keeps the defect and marks it skipped", async () => {
    const failing = { chat: { completions: { create: vi.fn(async () => { throw new Error("boom"); }) } } } as unknown as OpenAI;
    const verdicts: AuditOutcome[] = [];
    const out = await verifyDefects([visual("v")], {
      ...baseOpts(failing),
      onVerdict: (_id, v) => verdicts.push(v),
    });
    expect(out).toHaveLength(1);
    expect(out[0].verification?.verdict).toBe("skipped");
    expect(verdicts).toEqual([{ verdict: "skipped", reason: expect.stringContaining("boom") }]);
  });

  it("drop verdicts remove defects and downgrade verdicts convert to voice", async () => {
    const { client } = mockClient(async (i) =>
      JSON.stringify(
        i === 0
          ? { verdict: "drop", reason: "healthy" }
          : { verdict: "downgrade", reason: "unclear" },
      ),
    );
    const out = await verifyDefects([visual("a", "CRITICAL"), visual("b", "HIGH")], baseOpts(client));
    expect(out.map((d) => d.id)).toEqual(["b"]);
    expect(out[0].evidenceSource).toBe("voice");
    expect(out[0].verification?.verdict).toBe("downgrade");
  });

  it("calls checkCancel per candidate and reports via onVerdict", async () => {
    const { client } = mockClient(async () => keepPayload("ok"));
    const cancels = vi.fn();
    const seen: [string, AuditOutcome][] = [];
    await verifyDefects([visual("a"), visual("b"), voiceOnly("c")], {
      ...baseOpts(client),
      checkCancel: cancels,
      onVerdict: (id, v) => seen.push([id, v]),
    });
    expect(cancels).toHaveBeenCalledTimes(2); // visual candidates only
    expect(seen.map(([id]) => id)).toEqual(["a", "b"]);
  });

  it("lets cancellation propagate instead of converting to skipped", async () => {
    const { client } = mockClient(async () => keepPayload());
    await expect(
      verifyDefects([visual("a")], {
        ...baseOpts(client),
        checkCancel: () => { throw new Error("__CANCELLED__"); },
      }),
    ).rejects.toThrow("__CANCELLED__");
  });

  it("empty input returns empty output without model calls", async () => {
    const { client, create } = mockClient(async () => keepPayload());
    expect(await verifyDefects([], baseOpts(client))).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it("verifies the cited frame, not the nearest timestamp", async () => {
    let seenImage = "";
    const create = vi.fn(async (args: unknown) => {
      const parts = (args as { messages: { content: { text?: string; image_url?: { url: string } }[] }[] }).messages[1].content;
      for (const p of parts) {
        if (p.image_url?.url) seenImage = p.image_url.url;
      }
      return { choices: [{ message: { content: keepPayload("cited frame confirms rust") } }] };
    });
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const frames = [
      { timestamp: 5, base64: "NEAREST" },
      { timestamp: 30, base64: "CITED" },
    ];
    // frameTimestamp (6) is nearest to frames[0], but the finding cites frames[1].
    const d: Defect = { ...visual("cited", "HIGH", 6), evidenceFrameIndex: 1 };
    const out = await verifyDefects([d], { ...baseOpts(client), frames });
    expect(seenImage).toBe("data:image/jpeg;base64,CITED");
    expect(out[0].verification?.verdict).toBe("keep");
  });

  it("marks skipped when the cited frame is missing or invalid", async () => {
    const { client, create } = mockClient(async () => keepPayload());
    const frames = [{ timestamp: 10, base64: "AAA" }];
    const badIdx: Defect = { ...visual("bad", "HIGH", 10), evidenceFrameIndex: 9 };
    const noIdx: Defect = { ...visual("none", "HIGH", 10), evidenceFrameIndex: undefined };
    const out = await verifyDefects([badIdx, noIdx], { ...baseOpts(client), frames });
    expect(create).not.toHaveBeenCalled(); // no model call fabricates verification
    expect(out).toHaveLength(2);
    expect(out.every((d) => d.verification?.verdict === "skipped")).toBe(true);
    // Findings are preserved with evidence intact — never dropped, never auto-kept.
    expect(out.every((d) => d.evidenceSource === "visual")).toBe(true);
  });

  it("treats an empty frame array as unverifiable, never as verified", async () => {
    const { client, create } = mockClient(async () => keepPayload());
    const out = await verifyDefects([visual("e")], { ...baseOpts(client), frames: [] });
    expect(create).not.toHaveBeenCalled();
    expect(out[0].verification?.verdict).toBe("skipped");
    expect(out[0].evidenceSource).toBe("visual");
  });
});
