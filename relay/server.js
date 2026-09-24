/**
 * The relay: serves the site in docs/ and answers POST /v1/decide by asking Jev, adding the
 * TypeSafe key from TYPESAFE_API_KEY on the server so it never reaches a browser. The TypeSafe
 * API does not accept requests from web pages, so the GitHub Pages copy of the site sends its
 * questions here.
 *
 * The relay is not a general TypeSafe proxy: a visitor sends only a question and optional
 * details, and the relay builds the one request that decides it (see decide.js).
 *
 *   POST /v1/decide   {question, details?}  ->  {verdict, yes, torn, importance, model}
 *   GET  /v1/health   {ok, model, jev}: whether the relay has a key and budget left today
 *
 * Settings come from the environment or .env (see .env.example):
 *   TYPESAFE_API_KEY    the key that pays for decisions
 *   PORT                listening port on 127.0.0.1 (default 8788)
 *   ALLOWED_ORIGINS     sites allowed to call the relay, comma separated
 *   PUBLIC_HOSTS        host names the relay answers to behind a proxy, comma separated
 *   DAILY_TOKEN_BUDGET  input tokens per UTC day the key may spend (0: no limit)
 *   PER_MINUTE          decisions per minute per visitor address (default 20)
 *   TRUST_PROXY         1 when a reverse proxy sets X-Real-IP
 *
 *   node relay/server.js [--port 8788]
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildRequest, interpret, parseInput, MODEL, TYPESAFE_URL } from "./decide.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..", "docs");
const MAX_BODY = 8 * 1024;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...headers });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) reject(new Error("too large")), req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * @param {{port: number, apiKey?: string, origins?: string[], hosts?: string[], dailyTokens?: number,
 *          perMinute?: number, trustProxy?: boolean, fetchImpl?: typeof fetch}} opts
 * Only listed origins may call the relay from a page. Requests must be JSON, which a foreign page
 * cannot send without a CORS preflight, and preflights are answered only for listed origins.
 */
export function createServer({ port, apiKey = "", origins = [], hosts = [], dailyTokens = 0, perMinute = 20, trustProxy = false, fetchImpl = fetch }) {
  const local = [`localhost:${port}`, `127.0.0.1:${port}`];
  const allowed = new Set([...local.map((h) => `http://${h}`), ...origins, ...hosts.map((h) => `https://${h}`)]);
  const knownHosts = new Set([...local, ...hosts]); // Host checks stop DNS rebinding
  const spent = { day: "", tokens: 0 }; // input tokens the key used today (UTC)
  const today = () => new Date().toISOString().slice(0, 10);
  const recent = new Map(); // visitor address -> times of their decisions in the last minute

  function overLimit(ip) {
    const now = Date.now();
    const times = (recent.get(ip) || []).filter((t) => now - t < 60_000);
    if (recent.size > 10_000) recent.clear();
    if (times.length >= perMinute) return recent.set(ip, times), true;
    times.push(now);
    recent.set(ip, times);
    return false;
  }

  function budgetLeft() {
    if (spent.day !== today()) Object.assign(spent, { day: today(), tokens: 0 });
    return !dailyTokens || spent.tokens < dailyTokens;
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (!knownHosts.has(req.headers.host)) return send(res, 403, "text/plain", "Unknown host");

    if (url.pathname.startsWith("/v1/")) {
      const origin = req.headers.origin;
      if (origin && !allowed.has(origin)) return send(res, 403, "text/plain", "Foreign origin");
      const cors = origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
      const reply = (status, data) => send(res, status, "application/json", JSON.stringify(data), cors);
      if (req.method === "OPTIONS") {
        return send(res, 204, "text/plain", "", {
          ...cors,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "600",
        });
      }

      if (url.pathname === "/v1/health") {
        if (req.method !== "GET") return reply(405, { detail: "GET only" });
        return reply(200, { ok: true, model: MODEL, jev: Boolean(apiKey) && budgetLeft() });
      }

      if (url.pathname !== "/v1/decide") return reply(404, { detail: "Not found" });
      if (req.method !== "POST") return reply(405, { detail: "POST only" });
      if (!/^application\/json/.test(req.headers["content-type"] || "")) return reply(415, { detail: "JSON only" });
      if (!apiKey) return reply(503, { detail: "Jev is not set up on this server yet." });
      const ip = (trustProxy && req.headers["x-real-ip"]) || req.socket.remoteAddress || "";
      if (!budgetLeft()) return reply(429, { detail: "Jev has made all the decisions it can afford today. The coin is still here, and Jev is back tomorrow." });
      if (overLimit(ip)) return send(res, 429, "application/json", JSON.stringify({ detail: "Slow down, partner: that is a lot of decisions for one minute." }), { ...cors, "Retry-After": "30" });

      let input;
      try {
        input = parseInput(JSON.parse(await readBody(req)));
      } catch (err) {
        return reply(err.message === "too large" ? 413 : 400, { detail: err.message === "too large" ? "Request too large" : "Send JSON." });
      }
      if (input.error) return reply(400, { detail: input.error });

      try {
        const r = await fetchImpl(TYPESAFE_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(buildRequest(input)),
          signal: AbortSignal.timeout(20_000),
        });
        const text = await r.text();
        if (!r.ok) {
          console.error(`TypeSafe answered ${r.status}: ${text.slice(0, 300)}`);
          return reply(r.status === 429 ? 429 : 502, { detail: r.status === 429 ? "Jev is busy. Try again in a few seconds." : "Jev could not be reached. Try again, or ask the coin." });
        }
        const out = JSON.parse(text);
        spent.tokens += Number(out.usage?.input_tokens) || 0;
        const { verdict, yes, torn, importance, model } = interpret(out);
        return reply(200, { verdict, yes, torn, importance, model });
      } catch (err) {
        console.error(`Decision failed: ${err.message}`);
        return reply(502, { detail: "Jev could not be reached. Try again, or ask the coin." });
      }
    }

    // The site itself, for local use and for a copy served beside the relay.
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "text/plain", "GET only");
    let file;
    try {
      file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
    } catch {
      return send(res, 400, "text/plain", "Bad address");
    }
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return send(res, 403, "text/plain", "Forbidden");
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) return send(res, 404, "text/plain", "Not found");
    return send(res, 200, TYPES[path.extname(file)] || "application/octet-stream", fs.readFileSync(file), { "Cache-Control": "no-cache" });
  });
}

/** KEY=value lines from .env at the repository root; the environment wins. */
function loadEnv() {
  const file = path.join(here, "..", ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
}

// Run when started directly, including under a process manager such as pm2, which starts this file
// from its own wrapper and names it in pm_exec_path.
const entry = process.env.pm_exec_path || process.argv[1];
if (entry && pathToFileURL(entry).href === import.meta.url) {
  loadEnv();
  const argPort = process.argv.indexOf("--port");
  const port = Number(argPort > 0 ? process.argv[argPort + 1] : process.env.PORT) || 8788;
  const list = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
  const server = createServer({
    port,
    apiKey: process.env.TYPESAFE_API_KEY || "",
    origins: list(process.env.ALLOWED_ORIGINS),
    hosts: list(process.env.PUBLIC_HOSTS),
    dailyTokens: Number(process.env.DAILY_TOKEN_BUDGET) || 0,
    perMinute: Number(process.env.PER_MINUTE) || 20,
    trustProxy: process.env.TRUST_PROXY === "1",
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Let Jev Decide on http://localhost:${port}${process.env.TYPESAFE_API_KEY ? "" : " (no TYPESAFE_API_KEY: only the coin works)"}`);
  });
}
