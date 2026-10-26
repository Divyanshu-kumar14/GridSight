import OpenAI from "openai";

// Contract: builds the single shared Meta Model API client.
// Input: none (reads MODEL_API_KEY from env).
// Output: configured OpenAI client pointed at https://api.meta.ai/v1.
// Errors: throws loudly if MODEL_API_KEY is missing (never silently misconfigures).
// Normal: key set → client. Empty: throws. Invalid: API returns 401 at call time (surfaced by caller).

const META_BASE_URL = "https://api.meta.ai/v1";

let cached: OpenAI | null = null;

export function getMetaClient(): OpenAI {
  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) {
    throw new Error(
      "MODEL_API_KEY is not set. Add it to .env.local (see .env.example).",
    );
  }
  if (!cached) {
    cached = new OpenAI({ baseURL: META_BASE_URL, apiKey });
  }
  return cached;
}

export { META_BASE_URL };
