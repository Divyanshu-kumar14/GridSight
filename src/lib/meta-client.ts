import OpenAI from "openai";
import { META_BASE_URL, getSparkConfig } from "./models";

// Contract: shared OpenAI-compatible clients for Meta + Spark providers.
// SERVER-ONLY: this module reads secrets from process.env. Never import it from
// client components, never return key VALUES, never log them.
// Clients are cached in a Map keyed by `${provider}:${baseURL}:${model}` — a single
// cached client would silently reuse the wrong endpoint after a provider change.
// Key handling: env var NAMES travel through config; values are read here only,
// never logged, never returned.
// getMetaClient(): Meta endpoints (Files upload, SAM tracking). Unchanged behavior.
// getSparkClient(): resolved SPARK_PROVIDER endpoint (tagging + report generation).
// Modal Shared Endpoint auth: MODAL_API_KEY (legacy single Bearer) OR the proxy
// pair MODAL_PROXY_TOKEN_ID + MODAL_PROXY_TOKEN_SECRET joined as
// `${id}.${secret}` (Modal docs: combined value is usable as the OpenAI apiKey).
// Both throw loudly on missing keys (never silently misconfigure or fall back).

const clients = new Map<string, OpenAI>();

// Bounded request budget: 60s per request, no silent infinite retries.
const SPARK_TIMEOUT_MS = 60_000;
const SPARK_MAX_RETRIES = 2;

function getOrCreate(cacheKey: string, baseURL: string, apiKey: string): OpenAI {
  const hit = clients.get(cacheKey);
  if (hit) return hit;
  const client = new OpenAI({ baseURL, apiKey, timeout: SPARK_TIMEOUT_MS, maxRetries: SPARK_MAX_RETRIES });
  clients.set(cacheKey, client);
  return client;
}

export function getMetaClient(): OpenAI {
  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) {
    throw new Error(
      "MODEL_API_KEY is not set. Add it to .env.local (see .env.example).",
    );
  }
  return getOrCreate(`meta:${META_BASE_URL}:default`, META_BASE_URL, apiKey);
}

export function getSparkClient(): OpenAI {
  const cfg = getSparkConfig();
  if (cfg.provider === "modal") {
    const { key, mode } = resolveModalApiKey();
    // Auth mode in the cache key so switching from MODAL_API_KEY to the proxy
    // pair (or vice versa) never reuses a client built with the other secret.
    // The key VALUE never enters the cache key.
    return getOrCreate(`modal:${cfg.baseURL}:${cfg.model}:${mode}`, cfg.baseURL, key);
  }
  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`SPARK_PROVIDER=${cfg.provider} requires ${cfg.apiKeyEnv} (see .env.example).`);
  }
  return getOrCreate(`${cfg.provider}:${cfg.baseURL}:${cfg.model}`, cfg.baseURL, apiKey);
}

// Modal auth resolution (server-only). Prefers legacy MODAL_API_KEY when set,
// else joins the Shared Endpoint proxy pair. Throws actionable without ever
// including secret values in the message.
export function resolveModalApiKey(): { key: string; mode: "apikey" | "proxy" } {
  const legacy = process.env.MODAL_API_KEY;
  if (legacy) return { key: legacy, mode: "apikey" };
  const id = process.env.MODAL_PROXY_TOKEN_ID;
  const secret = process.env.MODAL_PROXY_TOKEN_SECRET;
  if (id && secret) return { key: `${id}.${secret}`, mode: "proxy" };
  throw new Error(
    "SPARK_PROVIDER=modal requires MODAL_API_KEY or MODAL_PROXY_TOKEN_ID + MODAL_PROXY_TOKEN_SECRET (see .env.example).",
  );
}

export { META_BASE_URL };
