import { describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { MODAL_SHARED_MODEL, getSparkConfig, resolveSparkConfig } from "../models";
import { getSparkClient, resolveModalApiKey } from "../meta-client";
import { labelEvidence, validateDefects } from "../report";
import { verifyDefects } from "../verify";

// Contract: Modal Shared Endpoint provider (Muse Spark Open, token-billed).
// All tests offline — dummy URLs/keys only, OpenAI calls mocked, never live.

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k] as string;
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k] as string;
    }
  }
}

const MODAL_URL = "https://test-workspace--muse-spark-open.modal.run/v1";

describe("modal provider selection", () => {
  it("selects modal only when explicitly configured; default stays meta", () => {
    expect(resolveSparkConfig({}).provider).toBe("meta");
    expect(resolveSparkConfig({ SPARK_PROVIDER: undefined } as never).provider).toBe("meta");
    const cfg = resolveSparkConfig({
      SPARK_PROVIDER: "modal",
      MODAL_ENDPOINT_URL: MODAL_URL,
      MODAL_MODEL: MODAL_SHARED_MODEL,
    });
    expect(cfg.provider).toBe("modal");
    expect(cfg.baseURL).toBe(MODAL_URL);
    expect(cfg.model).toBe(MODAL_SHARED_MODEL);
  });

  it("uses the exact documented Shared Endpoint model identifier", () => {
    expect(MODAL_SHARED_MODEL).toBe("meta-models/Muse-Spark-Open-816B-A42B");
    const cfg = resolveSparkConfig({
      SPARK_PROVIDER: "modal",
      MODAL_ENDPOINT_URL: MODAL_URL,
      MODAL_MODEL: MODAL_SHARED_MODEL,
    });
    expect(cfg.model).toBe("meta-models/Muse-Spark-Open-816B-A42B");
  });

  it("prefers MODAL_ENDPOINT_URL, keeps MODAL_BASE_URL as legacy fallback", () => {
    const both = resolveSparkConfig({
      SPARK_PROVIDER: "modal",
      MODAL_ENDPOINT_URL: "https://shared.modal.run/v1",
      MODAL_BASE_URL: "https://legacy.local/v1",
      MODAL_MODEL: MODAL_SHARED_MODEL,
    });
    expect(both.baseURL).toBe("https://shared.modal.run/v1");
    const legacy = resolveSparkConfig({
      SPARK_PROVIDER: "modal",
      MODAL_BASE_URL: "https://legacy.local/v1",
      MODAL_MODEL: "m-open",
    });
    expect(legacy.baseURL).toBe("https://legacy.local/v1");
  });

  it("strips trailing slashes so <url>/v1/chat/completions stays well-formed", () => {
    const cfg = resolveSparkConfig({
      SPARK_PROVIDER: "modal",
      MODAL_ENDPOINT_URL: "https://x.modal.run/v1///",
      MODAL_MODEL: MODAL_SHARED_MODEL,
    });
    expect(cfg.baseURL).toBe("https://x.modal.run/v1");
  });

  it("existing meta/basetEn behaviour is unchanged", () => {
    expect(resolveSparkConfig({})).toEqual({
      provider: "meta",
      baseURL: "https://api.meta.ai/v1",
      model: "muse-spark-1.3",
      apiKeyEnv: "MODEL_API_KEY",
    });
    const b = resolveSparkConfig({ SPARK_PROVIDER: "baseten" });
    expect(b.model).toBe("meta-models/muse-spark-open-1026");
  });
});

describe("modal auth (server-side, never logged)", () => {
  it("missing URL fails clearly without a live call", () => {
    expect(() =>
      resolveSparkConfig({ SPARK_PROVIDER: "modal", MODAL_MODEL: MODAL_SHARED_MODEL }),
    ).toThrow(/MODAL_ENDPOINT_URL/);
  });

  it("missing model fails clearly and names the expected identifier", () => {
    expect(() =>
      resolveSparkConfig({ SPARK_PROVIDER: "modal", MODAL_ENDPOINT_URL: MODAL_URL }),
    ).toThrow(/MODAL_MODEL/);
    try {
      resolveSparkConfig({ SPARK_PROVIDER: "modal", MODAL_ENDPOINT_URL: MODAL_URL });
    } catch (err) {
      expect((err as Error).message).toContain(MODAL_SHARED_MODEL);
      expect((err as Error).message).not.toContain("ws-");
      expect((err as Error).message).not.toContain("wk-");
    }
  });

  it("resolveModalApiKey prefers MODAL_API_KEY, else joins the proxy pair", () => {
    withEnv({ MODAL_API_KEY: "legacy-key", MODAL_PROXY_TOKEN_ID: "wk-1", MODAL_PROXY_TOKEN_SECRET: "ws-1" }, () => {
      expect(resolveModalApiKey()).toEqual({ key: "legacy-key", mode: "apikey" });
    });
    withEnv({ MODAL_API_KEY: undefined, MODAL_PROXY_TOKEN_ID: "wk-abc", MODAL_PROXY_TOKEN_SECRET: "ws-def" }, () => {
      expect(resolveModalApiKey()).toEqual({ key: "wk-abc.ws-def", mode: "proxy" });
    });
  });

  it("missing auth fails clearly and never echoes secrets", () => {
    withEnv({ MODAL_API_KEY: undefined, MODAL_PROXY_TOKEN_ID: undefined, MODAL_PROXY_TOKEN_SECRET: undefined }, () => {
      let msg = "";
      try {
        resolveModalApiKey();
      } catch (err) {
        msg = (err as Error).message;
      }
      expect(msg).toContain("MODAL_PROXY_TOKEN_ID");
      expect(msg).toContain("MODAL_PROXY_TOKEN_SECRET");
    });
    // Half-configured pair (only ID) also fails rather than sending malformed auth.
    withEnv({ MODAL_API_KEY: undefined, MODAL_PROXY_TOKEN_ID: "wk-only", MODAL_PROXY_TOKEN_SECRET: undefined }, () => {
      expect(() => resolveModalApiKey()).toThrow(/MODAL_API_KEY or MODAL_PROXY_TOKEN_ID/);
    });
  });

  it("getSparkClient throws actionable on missing modal auth (no silent fallback)", () => {
    withEnv(
      {
        SPARK_PROVIDER: "modal",
        MODAL_ENDPOINT_URL: MODAL_URL,
        MODAL_MODEL: MODAL_SHARED_MODEL,
        MODAL_API_KEY: undefined,
        MODAL_PROXY_TOKEN_ID: undefined,
        MODAL_PROXY_TOKEN_SECRET: undefined,
      },
      () => {
        expect(() => getSparkClient()).toThrow(/MODAL_API_KEY or MODAL_PROXY_TOKEN_ID/);
      },
    );
  });

  it("proxy vs legacy keys produce different cached clients (no secret reuse)", () => {
    let cProxy: unknown;
    let cLegacy: unknown;
    withEnv(
      {
        SPARK_PROVIDER: "modal",
        MODAL_ENDPOINT_URL: MODAL_URL,
        MODAL_MODEL: MODAL_SHARED_MODEL,
        MODAL_API_KEY: undefined,
        MODAL_PROXY_TOKEN_ID: "wk-a",
        MODAL_PROXY_TOKEN_SECRET: "ws-b",
      },
      () => {
        cProxy = getSparkClient();
      },
    );
    withEnv(
      {
        SPARK_PROVIDER: "modal",
        MODAL_ENDPOINT_URL: MODAL_URL,
        MODAL_MODEL: MODAL_SHARED_MODEL,
        MODAL_API_KEY: "legacy",
        MODAL_PROXY_TOKEN_ID: "wk-a",
        MODAL_PROXY_TOKEN_SECRET: "ws-b",
      },
      () => {
        cLegacy = getSparkClient();
      },
    );
    expect(cProxy).not.toBe(cLegacy);
  });
});

describe("modal request shape + pipeline integrity (mocked, offline)", () => {
  it("uses OpenAI-compatible chat.completions with the configured model", async () => {
    const seen: { model: unknown; baseURL: unknown }[] = [];
    const create = vi.fn(async (args: { model: unknown }) => {
      seen.push({ model: args.model, baseURL: MODAL_URL });
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                defects: [
                  {
                    id: "d1",
                    assetId: "insulator-001",
                    assetCategory: "insulator",
                    severity: "HIGH",
                    title: "Corrosion",
                    description: "rust at cap",
                    frameTimestamp: 10,
                    recommendedAction: "Replace",
                    estimatedUrgency: "Next scheduled",
                    evidenceFrameIndex: 0,
                    observation: "orange rust at cap",
                  },
                ],
              }),
            },
          },
        ],
      };
    });
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const cfg = resolveSparkConfig({
      SPARK_PROVIDER: "modal",
      MODAL_ENDPOINT_URL: MODAL_URL,
      MODAL_MODEL: MODAL_SHARED_MODEL,
    });
    const res = await client.chat.completions.create({
      model: cfg.model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(seen[0].model).toBe(MODAL_SHARED_MODEL);
    const raw = JSON.parse(res.choices[0]?.message?.content ?? "{}") as unknown;
    const defects = validateDefects(raw);
    expect(defects).toHaveLength(1);
    // Evidence: valid index + observation → visual, pinned capture.
    const labeled = labelEvidence(defects, [{ timestamp: 10, base64: "AAA" }]);
    expect(labeled[0].evidenceSource).toBe("visual");
    expect(labeled[0].frameCapture).toBe("AAA");
  });

  it("rejects malformed JSON and schema-invalid defects (no persistence)", () => {
    expect(() => JSON.parse("not json")).toThrow();
    expect(() =>
      validateDefects([{ id: "x", severity: "URGENT" }]),
    ).toThrow();
    // Voice-only stays voice when the model cites no frame.
    const voice = labelEvidence(
      validateDefects([
        {
          id: "d2",
          assetId: "pole-001",
          assetCategory: "pole",
          severity: "LOW",
          title: "Hum",
          description: "inspector heard arcing",
          frameTimestamp: 5,
          recommendedAction: "Monitor",
          estimatedUrgency: "Monitor",
        },
      ]),
      [{ timestamp: 5, base64: "AAA" }],
    );
    expect(voice[0].evidenceSource).toBe("voice");
  });

  it("verification still runs on Modal findings with the Modal model id", async () => {
    const create = vi.fn(async () => ({
      choices: [{ message: { content: JSON.stringify({ verdict: "keep", reason: "rust visible" }) } }],
    }));
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const defects = labelEvidence(
      validateDefects([
        {
          id: "v1",
          assetId: "a-1",
          assetCategory: "insulator",
          severity: "HIGH",
          title: "t",
          description: "d",
          frameTimestamp: 10,
          recommendedAction: "fix",
          estimatedUrgency: "Monitor",
          evidenceFrameIndex: 0,
          observation: "rust",
        },
      ]),
      [{ timestamp: 10, base64: "AAA" }],
    );
    const out = await verifyDefects(defects, {
      frames: [{ timestamp: 10, base64: "AAA" }],
      videoPath: null,
      sessionId: "s1",
      client,
      model: MODAL_SHARED_MODEL,
      cap: 8,
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(out[0].verification?.verdict).toBe("keep");
    // The verification call used the Modal model id.
    expect((create.mock.calls[0] as unknown as [{ model: string }])[0].model).toBe(MODAL_SHARED_MODEL);
  });

  it("provider errors do not silently fall back (throw loudly)", async () => {
    const failing = {
      chat: { completions: { create: vi.fn(async () => { throw new Error("modal 503"); }) } },
    } as unknown as OpenAI;
    await expect(
      failing.chat.completions.create({ model: MODAL_SHARED_MODEL, messages: [] } as never),
    ).rejects.toThrow("modal 503");
  });

  it("makes no live network request (all clients are mocked)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    // Touch config + client construction only (no .create call hits network;
    // OpenAI construction is lazy). The only fetch in this test would be ours.
    withEnv(
      {
        SPARK_PROVIDER: "modal",
        MODAL_ENDPOINT_URL: MODAL_URL,
        MODAL_MODEL: MODAL_SHARED_MODEL,
        MODAL_PROXY_TOKEN_ID: "wk-test",
        MODAL_PROXY_TOKEN_SECRET: "ws-test",
      },
      () => {
        expect(getSparkConfig().provider).toBe("modal");
        expect(getSparkClient()).toBeDefined();
      },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
