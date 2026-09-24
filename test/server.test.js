import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../relay/server.js";
import { MODEL, TYPESAFE_URL } from "../relay/decide.js";

const PORT = 18799;
const base = `http://127.0.0.1:${PORT}`;
const calls = [];
let reply = () => ({
  status: 200,
  body: {
    model: MODEL,
    answers: {
      crisis: { type: "noul", noul: 0.02 },
      is_yes_no: { type: "noul", noul: 0.98 },
      decide: { type: "noul", noul: 0.83 },
      importance: { type: "score", score: 3 },
    },
    usage: { input_tokens: 800, output_tokens: 20 },
  },
});
const fakeFetch = async (url, init) => {
  calls.push({ url, init });
  const r = reply();
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
};

let server;
before(async () => {
  server = createServer({
    port: PORT,
    apiKey: "test-key",
    origins: ["https://choxos.github.io"],
    hosts: ["letjevdecide.example"],
    dailyTokens: 2000,
    perMinute: 50,
    fetchImpl: fakeFetch,
  });
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
});
after(() => server.close());

const decide = (body, headers = {}) =>
  fetch(`${base}/v1/decide`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

test("a decision goes to TypeSafe with the server's key and comes back trimmed", async () => {
  const r = await decide({ question: "Should I quit my job?", details: "Boss yells." }, { Origin: "https://choxos.github.io" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), "https://choxos.github.io");
  const data = await r.json();
  assert.deepEqual(Object.keys(data).sort(), ["importance", "model", "torn", "verdict", "yes"]);
  assert.equal(data.verdict, "yes");
  const sent = calls.at(-1);
  assert.equal(sent.url, TYPESAFE_URL);
  assert.equal(sent.init.headers.Authorization, "Bearer test-key");
  assert.equal(JSON.parse(sent.init.body).state.details, "Boss yells.");
});

test("foreign origins, unknown hosts and non-JSON requests are refused", async () => {
  assert.equal((await decide({ question: "Should I?" }, { Origin: "https://evil.example" })).status, 403);
  const preflight = await fetch(`${base}/v1/decide`, { method: "OPTIONS", headers: { Origin: "https://choxos.github.io" } });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("access-control-allow-methods"), /POST/);
  const text = await fetch(`${base}/v1/decide`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
  assert.equal(text.status, 415);
  const http = await import("node:http");
  const status = await new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port: PORT, path: "/v1/health", headers: { Host: "rebound.example" } }, (res) => resolve(res.statusCode));
  });
  assert.equal(status, 403);
});

test("bad questions are rejected before any request to TypeSafe", async () => {
  const before = calls.length;
  assert.equal((await decide({ question: "" })).status, 400);
  assert.equal((await decide({ question: "x".repeat(500) })).status, 400);
  const bad = await fetch(`${base}/v1/decide`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{nope" });
  assert.equal(bad.status, 400);
  assert.equal(calls.length, before);
});

test("TypeSafe errors become a short message without details from upstream", async () => {
  const saved = reply;
  reply = () => ({ status: 500, body: { detail: "internal secret stuff" } });
  const r = await decide({ question: "Should I move?" });
  reply = saved;
  assert.equal(r.status, 502);
  assert.doesNotMatch(await r.text(), /secret/);
});

test("health reports the model, the daily budget stops spending, and the site is served", async () => {
  const health = await (await fetch(`${base}/v1/health`)).json();
  assert.equal(health.model, MODEL);
  // Spend past the 2,000 token budget (each fake answer reports 800 input tokens).
  let last;
  for (let k = 0; k < 3; k++) last = await decide({ question: "Should I get a dog?" });
  assert.equal(last.status, 429);
  assert.match((await last.json()).detail, /today/);
  assert.equal((await (await fetch(`${base}/v1/health`)).json()).jev, false);
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Let Jev Decide/);
  assert.equal((await fetch(`${base}/..%2f.env`)).status, 403);
});

test("a visitor who asks too often is slowed down", async () => {
  const quick = createServer({ port: PORT + 1, apiKey: "k", perMinute: 2, fetchImpl: fakeFetch });
  await new Promise((r) => quick.listen(PORT + 1, "127.0.0.1", r));
  const ask = () => fetch(`http://127.0.0.1:${PORT + 1}/v1/decide`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "Should I nap?" }) });
  assert.equal((await ask()).status, 200);
  assert.equal((await ask()).status, 200);
  const third = await ask();
  assert.equal(third.status, 429);
  assert.equal(third.headers.get("retry-after"), "30");
  quick.close();
});
