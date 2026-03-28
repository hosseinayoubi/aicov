/**
 * Vercel Serverless Function: /api/stream
 * - Proxies xAI Chat Completions with stream=true (SSE upstream)
 * - Streams plain text back to the browser
 * - Supports conversation history for multi-turn context
 *
 * Env required: XAI_API_KEY
 * Env optional: XAI_MODEL, FRONTEND_ORIGIN
 */
const DEFAULT_MODEL = "grok-4-1-fast-non-reasoning";

function clamp(n, min, max) {
  const x = Number.isFinite(Number(n)) ? Number(n) : min;
  return Math.max(min, Math.min(max, x));
}

function normalizeModelName(model) {
  const m = String(model || "").trim();
  if (!m) return DEFAULT_MODEL;
  return m.replace("grok-4.1-", "grok-4-1-").replace("grok-4.1", "grok-4-1");
}

function buildSystemPrompt({ mode, userContext }) {
  // ── Proactive: allow 2-3 sentences (up from 1-2), cap at 60 words.
  // Removed "silent" framing so the model is more willing to engage.
  // Added "be specific and actionable" to improve suggestion quality.
  const PROACTIVE_SYSTEM_BASE =
    "You are a real-time AI copilot monitoring a live conversation. " +
    "Give 1-3 short, specific, actionable suggestions (max 60 words total). " +
    "Focus on what would genuinely help right now — concrete talking points, " +
    "missing context, or a better way to phrase something. " +
    "If nothing useful comes to mind, return exactly an empty string. " +
    "Never repeat a previous suggestion. " +
    "Always respond in English.";

  const DEEP_SYSTEM_BASE =
    "You are a fast, sharp AI assistant. The user is speaking to you directly. " +
    "Lead with a direct 1-sentence answer. " +
    "Add brief supporting detail only if it genuinely helps — no padding. " +
    "If the input is unclear or incomplete, ask exactly one short clarifying question instead of guessing. " +
    "Always respond in English.";

  const cleanCtx = String(userContext ?? "").trim();
  const base = mode === "deep" ? DEEP_SYSTEM_BASE : PROACTIVE_SYSTEM_BASE;
  return cleanCtx ? `${base}\n\nContext:\n${cleanCtx}` : base;
}

function getGenParams({ mode }) {
  if (mode === "deep") return { temperature: 0.4, max_tokens: 320 };
  // ↑ max_tokens 96 → 180: allows 2-3 sentences in proactive mode
  return { temperature: 0.25, max_tokens: 180 };
}

/**
 * Sanitize and cap conversation history from the client.
 */
function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim()
    )
    .slice(-10)
    .map((m) => ({
      role   : m.role,
      content: String(m.content).slice(0, 2000),
    }));
}

async function readJsonBody(req) {
  return await new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function setCors(req, res) {
  const allow = process.env.FRONTEND_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allow);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST")    { res.statusCode = 405; return res.end("Method Not Allowed"); }

  const XAI_API_KEY = process.env.XAI_API_KEY;
  if (!XAI_API_KEY) { res.statusCode = 500; return res.end("XAI_API_KEY is missing"); }

  let body;
  try { body = await readJsonBody(req); }
  catch { res.statusCode = 400; return res.end("Invalid JSON body"); }

  const text        = String(body.text || "").trim();
  const userContext = String(body.system || body.userContext || "").trim();
  const modeIn      = String(body.mode || "proactive").trim().toLowerCase();
  const mode        = modeIn === "deep" ? "deep" : "proactive";
  const history     = sanitizeHistory(body.history);

  if (!text)              { res.statusCode = 400; return res.end("Missing text"); }
  if (text.length > 6000) { res.statusCode = 413; return res.end("Text too long"); }

  const model         = normalizeModelName(process.env.XAI_MODEL || DEFAULT_MODEL);
  const systemContent = buildSystemPrompt({ mode, userContext });
  const { temperature, max_tokens } = getGenParams({ mode });
  const safeMaxTokens = clamp(max_tokens, 16, 800);

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");

  const messages = [
    { role: "system", content: systemContent },
    ...history,
    { role: "user",   content: text },
  ];

  const upstreamAbort = new AbortController();
  req.on("close", () => upstreamAbort.abort());

  const upstream = await fetch("https://api.x.ai/v1/chat/completions", {
    method : "POST",
    headers: {
      Authorization : `Bearer ${XAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: safeMaxTokens,
      stream    : true,
      messages,
    }),
    signal: upstreamAbort.signal,
  }).catch((err) => {
    if (err?.name !== "AbortError") console.error("Upstream fetch error:", err);
    return null;
  });

  if (!upstream) {
    try { res.end(); } catch {}
    return;
  }

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => "");
    res.statusCode = upstream.status || 502;
    return res.end(errText || "Upstream error");
  }

  const reader  = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload) continue;

        if (payload === "[DONE]") {
          res.end();
          return;
        }

        try {
          const json  = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta?.content;
          if (delta) res.write(String(delta));
        } catch {
          // ignore malformed SSE chunks
        }
      }
    }
  } catch {
    // client disconnected or upstream error — exit silently
  } finally {
    try { res.end(); } catch {}
  }
};
