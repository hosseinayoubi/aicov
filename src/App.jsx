\
import { useEffect, useMemo, useRef, useState } from "react";
import StatusBar from "./components/StatusBar.jsx";
import SuggestionPanel from "./components/SuggestionPanel.jsx";
import ChatBox from "./components/ChatBox.jsx";

function makeId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

// simple stable hash for dedupe
function hashText(s) {
  const str = String(s || "");
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

export default function App() {
  const [status, setStatus] = useState("idle"); // idle | unsupported | listening | thinking | replying | backend_error
  const [wsStatus, setWsStatus] = useState("connected"); // reuse UI label: connected | error
  const [systemPrompt, setSystemPrompt] = useState("You are a proactive AI copilot.");
  const [mode, setMode] = useState("proactive"); // proactive | deep

  // ✅ Toggle برای Live Transcript
  const [showLive, setShowLive] = useState(false);

  // transcript
  const [finalText, setFinalText] = useState("");
  const [interimText, setInterimText] = useState("");

  // reply
  const [reply, setReply] = useState("");
  const [liveReply, setLiveReply] = useState("");
  const [isListening, setIsListening] = useState(false);

  const recognitionRef = useRef(null);

  // Buffers
  const bufferFinalRef = useRef("");
  const lastSentHashRef = useRef("");

  // timers (adaptive/proactive)
  const shortSilenceTimerRef = useRef(null);
  const longGateTimerRef = useRef(null);

  // reply typing effect
  const typeTimerRef = useRef(null);

  // request tracking / cancellation
  const lastRequestIdRef = useRef("");
  const abortRef = useRef(null);

  const API_URL = useMemo(() => "/api/stream", []);

  function clearAdaptiveTimers() {
    if (shortSilenceTimerRef.current) clearTimeout(shortSilenceTimerRef.current);
    if (longGateTimerRef.current) clearTimeout(longGateTimerRef.current);
    shortSilenceTimerRef.current = null;
    longGateTimerRef.current = null;
  }

  function startTypeReply(text) {
    const words = String(text || "").split(/\s+/).filter(Boolean);
    let i = 0;
    setLiveReply("");
    if (typeTimerRef.current) clearInterval(typeTimerRef.current);

    typeTimerRef.current = setInterval(() => {
      i++;
      setLiveReply(words.slice(0, i).join(" "));
      if (i >= words.length) {
        clearInterval(typeTimerRef.current);
        typeTimerRef.current = null;
      }
    }, 30);
  }

  async function sendToBackend(text) {
    const clean = String(text || "").trim();
    if (!clean) return;

    // dedupe: avoid sending near-identical text bursts
    const h = hashText(clean);
    if (h === lastSentHashRef.current) return;
    lastSentHashRef.current = h;

    // abort previous in-flight request (keep UI snappy)
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const requestId = makeId();
    lastRequestIdRef.current = requestId;

    setStatus("thinking");
    setWsStatus("connected");
    setReply("");
    setLiveReply("");

    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: clean,
          system: systemPrompt,
          mode,
          requestId,
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const t = await res.text().catch(() => "");
        console.error("API error:", res.status, t);
        setWsStatus("error");
        setStatus("backend_error");
        return;
      }

      // Stream plain text
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";

      setStatus("replying");

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (!chunk) continue;

        // ignore if a newer request started
        if (lastRequestIdRef.current !== requestId) return;

        acc += chunk;
        setLiveReply(acc);
      }

      if (lastRequestIdRef.current !== requestId) return;

      const final = String(acc || "").trim();
      setReply(final);
      startTypeReply(final);
      setStatus("replying");
    } catch (e) {
      if (e?.name === "AbortError") return;
      console.error("Fetch failed:", e);
      setWsStatus("error");
      setStatus("backend_error");
    }
  }

  // ✅ Adaptive proactive:
  // - If user pauses ~700ms after a final chunk => send immediately (feels fast)
  // - Otherwise enforce 5s gate in proactive (fallback)
  function scheduleAdaptiveFlush() {
    const text = (bufferFinalRef.current || "").trim();
    if (!text) return;

    clearAdaptiveTimers();

    // pause trigger (fast)
    shortSilenceTimerRef.current = setTimeout(() => {
      const t = (bufferFinalRef.current || "").trim();
      if (t) {
        bufferFinalRef.current = "";
        sendToBackend(t);
      }
    }, 700);

    // fallback gate
    longGateTimerRef.current = setTimeout(() => {
      const t = (bufferFinalRef.current || "").trim();
      if (t) {
        bufferFinalRef.current = "";
        sendToBackend(t);
      }
    }, mode === "proactive" ? 5000 : 2000);
  }

  function initSpeech() {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition || null;

    if (!SpeechRecognition) {
      setStatus("unsupported");
      return;
    }

    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    rec.onresult = (e) => {
      let interim = "";
      let newFinal = "";

      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const t = r?.[0]?.transcript || "";
        if (r.isFinal) newFinal += " " + t;
        else interim += " " + t;
      }

      const cleanFinal = String(newFinal || "").trim();
      const cleanInterim = String(interim || "").trim();

      // ✅ always keep finalText accurate (even when showLive is off)
      if (cleanFinal) {
        setFinalText((prev) => (prev ? (prev + " " + cleanFinal).trim() : cleanFinal));
        bufferFinalRef.current = (bufferFinalRef.current + " " + cleanFinal).trim();
        scheduleAdaptiveFlush();
      }

      // ✅ only show interim when Live is ON
      setInterimText(showLive ? cleanInterim : "");
    };

    rec.onerror = (err) => {
      console.error("Speech error:", err);
      setStatus("idle");
      setIsListening(false);
    };

    rec.onend = () => {
      // If still supposed to listen, auto-restart (Chrome may stop after pauses)
      if (isListening) {
        try { rec.start(); } catch {}
      }
    };

    recognitionRef.current = rec;
  }

  useEffect(() => {
    initSpeech();
    return () => {
      try { recognitionRef.current?.stop?.(); } catch {}
      if (abortRef.current) abortRef.current.abort();
      clearAdaptiveTimers();
      if (typeTimerRef.current) clearInterval(typeTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // when toggling live transcript off, hide interim immediately
    if (!showLive) setInterimText("");
  }, [showLive]);

  function startListening() {
    if (!recognitionRef.current) return;
    setFinalText("");
    setInterimText("");
    bufferFinalRef.current = "";
    clearAdaptiveTimers();
    setReply("");
    setLiveReply("");
    setStatus("listening");
    setIsListening(true);

    try {
      recognitionRef.current.start();
    } catch (e) {
      // start() can throw if called twice quickly
      console.warn("start failed:", e);
    }
  }

  function stopListening() {
    setIsListening(false);
    setStatus("idle");
    clearAdaptiveTimers();

    // flush any remaining buffer once
    const t = (bufferFinalRef.current || "").trim();
    bufferFinalRef.current = "";
    if (t) sendToBackend(t);

    try {
      recognitionRef.current?.stop?.();
    } catch {}
  }

  const transcriptToShow = useMemo(() => {
    if (showLive) {
      return [finalText, interimText].filter(Boolean).join(" ").trim();
    }
    return finalText;
  }, [finalText, interimText, showLive]);

  return (
    <div className="wrap">
      <div className="top">
        <div className="title">AI Copilot</div>
        <StatusBar status={status} wsStatus={wsStatus} mode={mode} />
      </div>

      <div className="row">
        <button
          className={"btn " + (isListening ? "btnStop" : "btnStart")}
          onClick={isListening ? stopListening : startListening}
        >
          {isListening ? "Stop" : "Start"}
        </button>

        <select className="select" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="proactive">Proactive</option>
          <option value="deep">Deep</option>
        </select>

        <label className="toggle">
          <input type="checkbox" checked={showLive} onChange={(e) => setShowLive(e.target.checked)} />
          <span>Live transcript</span>
        </label>
      </div>

      <div className="grid">
        <div className="card">
          <div className="cardTitle">Transcript</div>
          <div className="transcriptBox">{transcriptToShow || "Say something..."}</div>
          <div className="hint">Adaptive: pause sends faster. Fallback gate: ~5s in proactive.</div>
        </div>

        <div className="card">
          <div className="cardTitle">Suggestion</div>
          <SuggestionPanel text={liveReply || reply} />
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <ChatBox systemPrompt={systemPrompt} setSystemPrompt={setSystemPrompt} />
      </div>

      <div className="foot">
        <span style={{ opacity: 0.7 }}>Vercel-only: Streaming HTTP (no WebSocket server).</span>
      </div>
    </div>
  );
}
