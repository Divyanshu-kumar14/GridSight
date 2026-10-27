import OpenAI from "openai";
import { META_BASE_URL, getSparkConfig } from "./models";

// Contract: shared OpenAI-compatible clients for Meta + Spark providers.
// Clients are cached in a Map keyed by `${provider}:${baseURL}:${model}` — a single
// cached client would silently reuse the wrong endpoint after a provider change.
// Key handling: env var NAMES travel through config; values are read here only,
// never logged, never returned.
// getMetaClient(): Meta endpoints (Files upload, SAM tracking). Unchanged behavior.
// getSparkClient(): resolved SPARK_PROVIDER endpoint (tagging + report generation).
// Both throw loudly on missing keys (never silently misconfigure or fall back).

const clients = new Map<string, OpenAI>();

function getOrCreate(cacheKey: string, baseURL: string, apiKey: string): OpenAI {
  const hit = clients.get(cacheKey);
  if (hit) return hit;
  const client = new OpenAI({ baseURL, apiKey });
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
  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`SPARK_PROVIDER=${cfg.provider} requires ${cfg.apiKeyEnv} (see .env.example).`);
  }
  return getOrCreate(`${cfg.provider}:${cfg.baseURL}:${cfg.model}`, cfg.baseURL, apiKey);
}

export { META_BASE_URL };
