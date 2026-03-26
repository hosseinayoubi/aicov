\
/**
 * Vercel Serverless Function: /api/stream
 * - Proxies xAI Chat Completions with stream=true (SSE upstream)
 * - Streams plain text back to the browser (ReadableStream over fetch)
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
  // keep compatibility with older naming styles
  return m.replace("grok-4.1-", "grok-4-1-").replace("grok-4.1", "grok-4-1");
}

function buildSystemPrompt({ mode, userContext }) {
  const PROACTIVE_SYSTEM_BASE =
    "You are a real-time proactive copilot. The user is speaking live. " +
    "Give a helpful, practical suggestion in up to 2 short sentences (max ~35 words). " +
    "If nothing useful, return an empty string. Do not repeat earlier suggestions.";

  const DEEP_SYSTEM_BASE =
    "You are an attentive AI listener. Answer fast but thoughtfully. " +
    "First give a short direct answer (1-2 sentences). " +
    "Then, if useful, add a 'Details' section with bullet points. " +
    "If the input is incomplete, ask ONE short clarifying question.";

  const cleanCtx = String(userContext ?? "").trim();
  const base = mode === "deep" ? DEEP_SYSTEM_BASE : PROACTIVE_SYSTEM_BASE;
  return cleanCtx ? `${base}\n\nContext:\n${cleanCtx}` : base;
}

function getGenParams({ mode }) {
  if (mode === "deep") return { temperature: 0.4, max_tokens: 320 };
  return { temperature: 0.25, max_tokens: 96 };
}

async function readJsonBody(req) {
  return await new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function setCors(req, res) {
  const allow = process.env.FRONTEND_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allow);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  // If you set a specific origin, you can also set:
  // res.setHeader("Vary", "Origin");
}

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end("Method Not Allowed");
  }

  const XAI_API_KEY = process.env.XAI_API_KEY;
  if (!XAI_API_KEY) {
    res.statusCode = 500;
    return res.end("XAI_API_KEY is missing");
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    res.statusCode = 400;
    return res.end("Invalid JSON body");
  }

  const text = String(body.text || "").trim();
  const userContext = String(body.system || body.userContext || "").trim();
  const modeIn = String(body.mode || "proactive").trim().toLowerCase();
  const mode = modeIn === "deep" ? "deep" : "proactive";

  // basic input limits (cost + safety)
  if (!text) {
    res.statusCode = 400;
    return res.end("Missing text");
  }
  if (text.length > 6000) {
    res.statusCode = 413;
    return res.end("Text too long");
  }

  const model = normalizeModelName(process.env.XAI_MODEL || DEFAULT_MODEL);
  const systemContent = buildSystemPrompt({ mode, userContext });
  const { temperature, max_tokens } = getGenParams({ mode });
  const safeMaxTokens = clamp(max_tokens, 16, 800);

  // Stream response as plain text
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");

  // Make the upstream request with SSE streaming
  const upstream = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${XAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: safeMaxTokens,
      stream: true,
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: text },
      ],
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => "");
    res.statusCode = upstream.status || 502;
    return res.end(errText || "Upstream error");
  }

  // Parse SSE from xAI and write only delta.content back as plain text
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE is line-based; parse complete lines
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
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta?.content;
          if (delta) res.write(String(delta));
        } catch {
          // ignore malformed SSE chunks
        }
      }
    }
  } catch (e) {
    // client may disconnect; just end
  } finally {
    try { res.end(); } catch {}
  }
};
