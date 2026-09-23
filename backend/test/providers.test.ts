import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { aiStatus, askAssistant } from "../src/providers.ts";

const KEYS = ["AI_PROVIDER", "AI_API_KEY", "AI_MODEL", "AI_ENDPOINT"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  globalThis.fetch = realFetch;
});

function captureFetch() {
  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  globalThis.fetch = (async (url: string, init: any) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: "hint" } }], usage: { total_tokens: 7 } }),
      { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

test("providers: gemini is the default provider", () => {
  delete process.env.AI_PROVIDER;
  assert.equal(aiStatus().provider, "gemini");
});

test("providers: gemini uses Google's OpenAI-compatible endpoint with bearer auth", async () => {
  Object.assign(process.env, { AI_PROVIDER: "gemini", AI_API_KEY: "k1", AI_MODEL: "gemini-3.8-flash" });
  const calls = captureFetch();
  const out = await askAssistant([{ role: "user", content: "hi" }]);
  assert.equal(out.text, "hint");
  assert.match(calls[0].url, /generativelanguage\.googleapis\.com/);
  assert.equal(calls[0].headers.authorization, "Bearer k1");
});

test("providers: openai provider requires AI_ENDPOINT and uses bearer auth", async () => {
  Object.assign(process.env, { AI_PROVIDER: "openai", AI_API_KEY: "k2", AI_MODEL: "m" });
  delete process.env.AI_ENDPOINT;
  assert.equal(aiStatus().enabled, false);

  process.env.AI_ENDPOINT = "https://llm.example.com/v1/chat/completions";
  assert.equal(aiStatus().enabled, true);
  const calls = captureFetch();
  await askAssistant([{ role: "user", content: "hi" }]);
  assert.equal(calls[0].url, "https://llm.example.com/v1/chat/completions");
  assert.equal(calls[0].headers.authorization, "Bearer k2");
  assert.equal(calls[0].headers["api-key"], undefined);
});

test("providers: azure keeps its api-key header", async () => {
  Object.assign(process.env, { AI_PROVIDER: "azure", AI_API_KEY: "k3", AI_MODEL: "m",
    AI_ENDPOINT: "https://res.openai.azure.com/openai/deployments/d/chat/completions" });
  const calls = captureFetch();
  await askAssistant([{ role: "user", content: "hi" }]);
  assert.equal(calls[0].headers["api-key"], "k3");
  assert.equal(calls[0].headers.authorization, undefined);
});

test("providers: non-https endpoints are refused", async () => {
  Object.assign(process.env, { AI_PROVIDER: "openai", AI_API_KEY: "k", AI_MODEL: "m",
    AI_ENDPOINT: "http://llm.example.com/v1/chat/completions" });
  await assert.rejects(() => askAssistant([{ role: "user", content: "hi" }]), /invalid/);
});
