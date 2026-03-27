import { useEffect, useMemo, useRef, useState } from "react";
import StatusBar from "./components/StatusBar.jsx";
import SuggestionPanel from "./components/SuggestionPanel.jsx";
import ChatBox from "./components/ChatBox.jsx";
import TranscriptPanel from "./components/TranscriptPanel.jsx";

/* ── Helpers ──────────────────────────────────────────────────────────── */
function makeId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function hashText(s) {
  const str = String(s || "");
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

/* ── Tuning constants ─────────────────────────────────────────────────── */
const AUTO_STOP_MS        = 2 * 60 * 1000; // 2 min
const RESTART_DEBOUNCE_MS = 100;           // gap before restarting recognition
const SHORT_SILENCE_MS    = 500;           // send after this pause (was 700)
const LONG_GATE_PROACTIVE = 3_000;         // fallback gate – proactive mode (was 5000)
const LONG_GATE_DEEP      = 1_500;         // fallback gate – deep mode (was 2000)
const WORD_FLUSH_THRESH   = 8;             // flush immediately at this many words

/* ─────────────────────────────────────────────────────────────────────── */

export default function App() {
  const [status,       setStatus]       = useState("idle");
  const [wsStatus,     setWsStatus]     = useState("connected");
  const [systemPrompt, setSystemPrompt] = useState("You are a proactive AI copilot.");
  const [mode,         setMode]         = useState("proactive");
  const [transcriptOpen, setTranscriptOpen] = useState(true);   // ← drawer state
  const [finalText,    setFinalText]    = useState("");
  const [interimText,  setInterimText]  = useState("");
  const [reply,        setReply]        = useState("");
  const [liveReply,    setLiveReply]    = useState("");
  const [isListening,  setIsListening]  = useState(false);

  /* ── Refs (prevent stale closures) ── */
  const isListeningRef     = useRef(false);
  const modeRef            = useRef("proactive");
  const systemPromptRef    = useRef("You are a proactive AI copilot.");

  const recognitionRef     = useRef(null);
  const recActiveRef       = useRef(false);  // true while rec.start() is in effect
  const bufferFinalRef     = useRef("");
  const lastSentHashRef    = useRef("");
  const shortSilTimerRef   = useRef(null);
  const longGateTimerRef   = useRef(null);
  const typeTimerRef       = useRef(null);
  const lastRequestIdRef   = useRef("");
  const abortRef           = useRef(null);
  const autoStopTimerRef   = useRef(null);
  const restartTimerRef    = useRef(null);

  /* ── Sync refs with state ── */
  useEffect(() => { isListeningRef.current  = isListening;  }, [isListening]);
  useEffect(() => { modeRef.current         = mode;         }, [mode]);
  useEffect(() => { systemPromptRef.current = systemPrompt; }, [systemPrompt]);

  /* ── Timer helpers ── */
  function clearAdaptiveTimers() {
    clearTimeout(shortSilTimerRef.current);
    clearTimeout(longGateTimerRef.current);
    shortSilTimerRef.current = null;
    longGateTimerRef.current  = null;
  }

  function resetAutoStop() {
    clearTimeout(autoStopTimerRef.current);
    autoStopTimerRef.current = setTimeout(() => {
      if (!isListeningRef.current) return;
      isListeningRef.current = false;
      recActiveRef.current   = false;
      setIsListening(false);
      setStatus("idle");
      clearAdaptiveTimers();
      bufferFinalRef.current = "";
      try { recognitionRef.current?.stop?.(); } catch {}
    }, AUTO_STOP_MS);
  }

  /* ── Typewriter ── */
  function startTypeReply(text) {
    const words = String(text || "").split(/\s+/).filter(Boolean);
    let i = 0;
    setLiveReply("");
    clearInterval(typeTimerRef.current);
    typeTimerRef.current = setInterval(() => {
      i++;
      setLiveReply(words.slice(0, i).join(" "));
      if (i >= words.length) {
        clearInterval(typeTimerRef.current);
        typeTimerRef.current = null;
      }
    }, 28);
  }

  /* ── Backend streaming ── */
  async function sendToBackend(text) {
    const clean = String(text || "").trim();
    if (!clean) return;

    const h = hashText(clean);
    if (h === lastSentHashRef.current) return;
    lastSentHashRef.current = h;

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId  = makeId();
    lastRequestIdRef.current = requestId;

    setStatus("thinking");
    setWsStatus("connected");
    setReply("");
    setLiveReply("");

    try {
      const res = await fetch("/api/stream", {
        method : "POST",
        headers: { "Content-Type": "application/json" },
        body   : JSON.stringify({
          text  : clean,
          system: systemPromptRef.current,
          mode  : modeRef.current,
          requestId,
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        setWsStatus("error");
        setStatus("backend_error");
        return;
      }

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      setStatus("replying");

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (!chunk) continue;
        if (lastRequestIdRef.current !== requestId) return;
        acc += chunk;
        setLiveReply(acc);
      }

      if (lastRequestIdRef.current !== requestId) return;
      const final = String(acc || "").trim();
      setReply(final);
      startTypeReply(final);
      setStatus(isListeningRef.current ? "listening" : "idle");
    } catch (e) {
      if (e?.name === "AbortError") return;
      console.error("Fetch failed:", e);
      setWsStatus("error");
      setStatus("backend_error");
    }
  }

  /* ── Flush buffer ── */
  function flushBuffer() {
    const t = (bufferFinalRef.current || "").trim();
    if (!t) return;
    bufferFinalRef.current = "";
    sendToBackend(t);
  }

  /* ── Adaptive send scheduler ── */
  function scheduleAdaptiveFlush() {
    if (!(bufferFinalRef.current || "").trim()) return;
    clearAdaptiveTimers();

    // Immediate flush if we already have enough words
    const words = bufferFinalRef.current.trim().split(/\s+/).length;
    if (words >= WORD_FLUSH_THRESH) {
      flushBuffer();
      return;
    }

    // Short-silence fast path
    shortSilTimerRef.current = setTimeout(flushBuffer, SHORT_SILENCE_MS);

    // Long-gate fallback
    const gateMs = modeRef.current === "proactive"
      ? LONG_GATE_PROACTIVE
      : LONG_GATE_DEEP;
    longGateTimerRef.current = setTimeout(flushBuffer, gateMs);
  }

  /* ── Safe recognition start (prevents double-start) ── */
  function safeStart() {
    if (!recognitionRef.current || recActiveRef.current) return;
    recActiveRef.current = true;
    try {
      recognitionRef.current.start();
    } catch (e) {
      recActiveRef.current = false;
      console.warn("rec.start() error:", e);
    }
  }

  /* ── Speech recognition init ── */
  function initSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setStatus("unsupported"); return; }

    const rec = new SR();
    rec.continuous      = true;
    rec.interimResults  = true;
    rec.lang            = "en-US";
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      recActiveRef.current = true;
    };

    rec.onresult = (e) => {
      let interim  = "";
      let newFinal = "";

      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const t = r?.[0]?.transcript || "";
        if (r.isFinal) newFinal += " " + t;
        else            interim  += " " + t;
      }

      const cleanFinal   = newFinal.trim();
      const cleanInterim = interim.trim();

      if (cleanFinal) {
        setFinalText((prev) =>
          (prev ? prev + " " + cleanFinal : cleanFinal).trim()
        );
        bufferFinalRef.current = (
          bufferFinalRef.current + " " + cleanFinal
        ).trim();
        scheduleAdaptiveFlush();
        resetAutoStop();
      }
      // Always update interim so the drawer shows live typing
      setInterimText(cleanInterim);
    };

    rec.onerror = (e) => {
      console.warn("Speech error:", e.error);
      recActiveRef.current = false;
      if (
        e.error === "not-allowed" ||
        e.error === "service-not-allowed"
      ) {
        setStatus("unsupported");
        setIsListening(false);
        isListeningRef.current = false;
      }
      // "no-speech", "audio-capture", "network" → let onend restart
    };

    rec.onend = () => {
      recActiveRef.current = false;
      if (!isListeningRef.current) return;
      // Debounced restart to avoid tight loops on rapid end/start cycles
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = setTimeout(() => {
        if (isListeningRef.current) safeStart();
      }, RESTART_DEBOUNCE_MS);
    };

    recognitionRef.current = rec;
  }

  useEffect(() => {
    initSpeech();
    return () => {
      isListeningRef.current = false;
      recActiveRef.current   = false;
      clearTimeout(restartTimerRef.current);
      try { recognitionRef.current?.stop?.(); } catch {}
      if (abortRef.current) abortRef.current.abort();
      clearAdaptiveTimers();
      clearInterval(typeTimerRef.current);
      clearTimeout(autoStopTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Controls ── */
  function startListening() {
    if (!recognitionRef.current) return;
    setFinalText("");
    setInterimText("");
    bufferFinalRef.current  = "";
    lastSentHashRef.current = "";
    clearAdaptiveTimers();
    setReply("");
    setLiveReply("");
    setStatus("listening");
    setIsListening(true);
    isListeningRef.current = true;
    resetAutoStop();
    safeStart();
  }

  function stopListening() {
    isListeningRef.current = false;
    recActiveRef.current   = false;
    setIsListening(false);
    setStatus("idle");
    clearAdaptiveTimers();
    clearTimeout(autoStopTimerRef.current);
    clearTimeout(restartTimerRef.current);
    const t = (bufferFinalRef.current || "").trim();
    bufferFinalRef.current = "";
    if (t) sendToBackend(t);
    try { recognitionRef.current?.stop?.(); } catch {}
  }

  function clearTranscript() {
    setFinalText("");
    setInterimText("");
    bufferFinalRef.current  = "";
    lastSentHashRef.current = "";
  }

  /* finalText (confirmed) is always shown; interim only inside the drawer */
  const unsupported = status === "unsupported";

  /* ── Render ── */
  return (
    <div className="appShell">

      {/* ── Header ── */}
      <div className="appTop">
        <div className="brand">
          <div className={`logoDot${isListening ? " logoDotActive" : ""}`} />
          <div>
            <div className="brandTitle">aico</div>
            <div className="brandSub">Realtime voice copilot</div>
          </div>
        </div>

        <div className="controlsRow">
          <button
            className={`chip${mode === "proactive" ? " active" : ""}`}
            onClick={() => setMode("proactive")}
          >
            ⚡ Proactive{mode === "proactive" ? " (adaptive)" : ""}
          </button>
          <button
            className={`chip${mode === "deep" ? " active" : ""}`}
            onClick={() => setMode("deep")}
          >
            🎧 Deep
          </button>
        </div>
      </div>

      {/* ── Status bar ── */}
      <StatusBar status={status} wsStatus={wsStatus} mode={mode} />

      {/* ── Context / Prompt ── */}
      <div className="card">
        <ChatBox systemPrompt={systemPrompt} setSystemPrompt={setSystemPrompt} />
      </div>

      {/* ── Live transcript — collapsible drawer ── */}
      <TranscriptPanel
        transcript={finalText}
        interimText={interimText}
        isOpen={transcriptOpen}
        onToggle={() => setTranscriptOpen((o) => !o)}
        onClear={clearTranscript}
        mode={mode}
      />

      {/* ── Copilot suggestion ── */}
      <div className="card">
        <div className="cardTitle">Copilot</div>
        <SuggestionPanel
          text={liveReply || reply}
          isListening={isListening}
          status={status}
        />
      </div>

      {/* ── Footer ── */}
      <div className="bottomBar">
        {unsupported ? (
          <span className="unsupportedNote">
            ⚠️ Speech recognition not supported in this browser.
          </span>
        ) : (
          <button
            className={`btn${isListening ? " btnStop" : " btnStart"}`}
            onClick={isListening ? stopListening : startListening}
          >
            {isListening ? "Stop" : "Start"}
          </button>
        )}
        <div className="meta">
          <span>aico.weomeo.win</span>
          <span>Auto-stop: 2 min</span>
        </div>
      </div>

    </div>
  );
}
