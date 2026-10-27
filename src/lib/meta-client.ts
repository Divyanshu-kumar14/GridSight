import OpenAI from "openai";
import { META_BASE_URL } from "./models";

// Contract: builds the single shared Meta Model API client.
// Input: none (reads MODEL_API_KEY from env).
// Output: configured OpenAI client pointed at META_BASE_URL (see ./models).
// Errors: throws loudly if MODEL_API_KEY is missing (never silently misconfigures).
// Normal: key set → client. Empty: throws. Invalid: API returns 401 at call time (surfaced by caller).

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
