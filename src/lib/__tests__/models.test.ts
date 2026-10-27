import { describe, expect, it } from "vitest";
import { getSparkClient } from "../meta-client";
import { getSparkConfig, resolveSparkConfig, sparkModel } from "../models";

// Contract: SPARK_PROVIDER switch (open-weight prize eligibility).
// Resolution is pure (takes env) — most tests inject env directly.
// The process.env readers (getSparkConfig/sparkModel/getSparkClient) run
// inside withEnv, which restores every key it touches.

// withEnv sets keys, runs fn, restores. undefined value = delete the key.
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

describe("resolveSparkConfig", () => {
  it("defaults to Meta with byte-identical behaviour to today", () => {
    expect(resolveSparkConfig({})).toEqual({
      provider: "meta",
      baseURL: "https://api.meta.ai/v1",
      model: "muse-spark-1.3",
      apiKeyEnv: "MODEL_API_KEY",
    });
  });

  it("resolves Baseten defaults (exact hackathon model id)", () => {
    const cfg = resolveSparkConfig({ SPARK_PROVIDER: "baseten" });
    expect(cfg.baseURL).toBe("https://inference.baseten.co/v1");
    expect(cfg.model).toBe("meta-models/muse-spark-open-1026");
    expect(cfg.model).not.toBe("meta-models/muse-spark-open");
    expect(cfg.apiKeyEnv).toBe("BASETEN_API_KEY");
  });

  it("env overrides beat defaults (precedence)", () => {
    expect(
      resolveSparkConfig({ SPARK_MODEL: "custom-spark" }).model,
    ).toBe("custom-spark");
    const baseten = resolveSparkConfig({
      SPARK_PROVIDER: "baseten",
      BASETEN_BASE_URL: "https://proxy.local/v1",
      BASETEN_MODEL: "custom-open",
    });
    expect(baseten.baseURL).toBe("https://proxy.local/v1");
    expect(baseten.model).toBe("custom-open");
  });

  it("modal requires baseURL and model (throws actionable)", () => {
    expect(() => resolveSparkConfig({ SPARK_PROVIDER: "modal" })).toThrow(/MODAL_BASE_URL/);
    expect(() =>
      resolveSparkConfig({ SPARK_PROVIDER: "modal", MODAL_BASE_URL: "https://m.local" }),
    ).toThrow(/MODAL_MODEL/);
    expect(
      resolveSparkConfig({
        SPARK_PROVIDER: "modal",
        MODAL_BASE_URL: "https://m.local",
        MODAL_MODEL: "m-open",
      }),
    ).toEqual({
      provider: "modal",
      baseURL: "https://m.local",
      model: "m-open",
      apiKeyEnv: "MODAL_API_KEY",
    });
  });

  it("rejects unknown providers loudly", () => {
    expect(() => resolveSparkConfig({ SPARK_PROVIDER: "openai" })).toThrow(/Unknown SPARK_PROVIDER/);
  });
});

describe("process.env readers", () => {
  it("getSparkConfig/sparkModel follow the live env", () => {
    withEnv({ SPARK_PROVIDER: undefined, SPARK_MODEL: undefined }, () => {
      expect(getSparkConfig().provider).toBe("meta");
      expect(sparkModel()).toBe("muse-spark-1.3");
    });
    withEnv({ SPARK_PROVIDER: "baseten" }, () => {
      expect(sparkModel()).toBe("meta-models/muse-spark-open-1026");
    });
  });

  it("getSparkClient throws actionable on missing provider key (no silent fallback)", () => {
    withEnv({ SPARK_PROVIDER: "baseten", BASETEN_API_KEY: undefined }, () => {
      expect(() => getSparkClient()).toThrow(
        "SPARK_PROVIDER=baseten requires BASETEN_API_KEY (see .env.example).",
      );
    });
    withEnv({ SPARK_PROVIDER: "modal", MODAL_BASE_URL: "https://m.local", MODAL_MODEL: "m-open", MODAL_API_KEY: undefined }, () => {
      expect(() => getSparkClient()).toThrow(
        /SPARK_PROVIDER=modal requires MODAL_API_KEY or MODAL_PROXY_TOKEN_ID/,
      );
    });
  });

  it("two providers produce two different cached clients (no endpoint reuse)", () => {
    let c1, c2, c1Again: unknown;
    withEnv({ SPARK_PROVIDER: "baseten", BASETEN_API_KEY: "dummy-baseten" }, () => {
      c1 = getSparkClient();
      c1Again = getSparkClient();
    });
    withEnv(
      {
        SPARK_PROVIDER: "modal",
        MODAL_BASE_URL: "https://m.local",
        MODAL_MODEL: "m-open",
        MODAL_API_KEY: "dummy-modal",
      },
      () => {
        c2 = getSparkClient();
      },
    );
    expect(c1Again).toBe(c1); // same endpoint+model → same instance
    expect(c2).not.toBe(c1); // different provider → different instance
  });
});
