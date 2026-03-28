import { useState, useRef, useCallback } from "react";
import ChatBox from "./components/ChatBox";
import StatusBar from "./components/StatusBar";
import SuggestionPanel from "./components/SuggestionPanel";
import TranscriptPanel from "./components/TranscriptPanel";

// ── Constants ─────────────────────────────────────────────────────────────────
const SILENCE_MS       = 280;   // was 500 — faster flush after silence
const FAST_FLUSH_WORDS = 5;     // was 8 — flush sooner
const GATE_MS          = { proactive: 1800, deep: 900 }; // was 3000/1500

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  // ── UI state ──────────────────────────────────────────────────────────────
  const [mode,           setModeState]      = useState("proactive");
  const [systemPrompt,   setSysState]       = useState("");
  const [transcript,     setTranscript]     = useState("");
  const [interimText,    setInterimText]    = useState("");
  const [suggestion,     setSuggestion]     = useState("");
  const [status,         setStatus]         = useState("idle");
  const [wsStatus,       setWsStatus]       = useState("disconnected");
  const [isListening,    setIsListening]    = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(true);

  // ── Mutable refs ──────────────────────────────────────────────────────────
  const recRef          = useRef(null);
  const abortCtrlRef    = useRef(null);
  const silenceTimerRef = useRef(null);
  const gateTimerRef    = useRef(null);
  const pendingRef      = useRef("");
  const lastSentRef     = useRef("");
  const historyRef      = useRef([]);
  const isOnRef         = useRef(false);
  const modeRef         = useRef("proactive");
  const sysRef          = useRef("");
  // Session counter — prevents stale onresult from old recognition instance
  // firing after auto-restart (root cause of duplicate words)
  const sessionRef      = useRef(0);

  // ── Sync helpers ──────────────────────────────────────────────────────────
  const setMode = (m) => { setModeState(m); modeRef.current = m; };
  const setSys  = (s) => { setSysState(s);  sysRef.current  = s; };

  // ── Timer helpers ─────────────────────────────────────────────────────────
  function clearTimers() {
    clearTimeout(silenceTimerRef.current);
    clearTimeout(gateTimerRef.current);
    silenceTimerRef.current = null;
    gateTimerRef.current    = null;
  }

  // ── Flush ─────────────────────────────────────────────────────────────────
  const flush = useCallback(async () => {
    const text = pendingRef.current.trim();
    if (!text || text === lastSentRef.current) return;

    pendingRef.current  = "";
    lastSentRef.current = text;

    abortCtrlRef.current?.abort();
    const ctrl = new AbortController();
    abortCtrlRef.current = ctrl;

    setStatus("thinking");
    setSuggestion("");

    try {
      const res = await fetch("/api/stream", {
        method : "POST",
        headers: { "Content-Type": "application/json" },
        body   : JSON.stringify({
          text,
          mode   : modeRef.current,
          system : sysRef.current,
          history: historyRef.current,
        }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "Unknown error");
        console.error("API error", res.status, errText);
        setStatus("backend_error");
        return;
      }

      if (!res.body) {
        setStatus("backend_error");
        return;
      }

      setStatus("replying");

      const reader   = res.body.getReader();
      const decoder  = new TextDecoder();
      let   fullText = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        fullText += chunk;
        setSuggestion(fullText);
      }

      const tail = decoder.decode();
      if (tail) { fullText += tail; setSuggestion(fullText); }

      const trimmed = fullText.trim();
      if (trimmed) {
        historyRef.current = [
          ...historyRef.current,
          { role: "user",      content: text    },
          { role: "assistant", content: trimmed },
        ].slice(-20);
      }

      setStatus(isOnRef.current ? "listening" : "idle");
    } catch (err) {
      if (err?.name === "AbortError") return;
      console.error("Fetch failed:", err);
      setStatus("backend_error");
    }
  }, []);

  // ── Schedule flush ────────────────────────────────────────────────────────
  function scheduleFlush() {
    clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = null;

    const words = pendingRef.current.trim().split(/\s+/).filter(Boolean).length;

    if (words >= FAST_FLUSH_WORDS) {
      clearTimers();
      flush();
      return;
    }

    silenceTimerRef.current = setTimeout(() => {
      clearTimers();
      flush();
    }, SILENCE_MS);

    if (!gateTimerRef.current) {
      gateTimerRef.current = setTimeout(() => {
        gateTimerRef.current = null;
        flush();
      }, GATE_MS[modeRef.current] ?? 1800);
    }
  }

  // ── Build SpeechRecognition ───────────────────────────────────────────────
  function buildRecognition() {
    if (!SR) return null;

    const rec           = new SR();
    rec.continuous      = true;
    rec.interimResults  = true;
    rec.lang            = "en-US";
    rec.maxAlternatives = 1;

    // Snapshot session ID at creation time.
    // If recognition restarts, sessionRef increments and
    // old onresult callbacks become no-ops — this kills duplicate words.
    const mySession = ++sessionRef.current;

    rec.onstart = () => {
      setStatus("listening");
      setWsStatus("connected");
      setIsListening(true);
    };

    rec.onend = () => {
      if (isOnRef.current) {
        sessionRef.current++;   // invalidate stale events from this instance
        try { rec.start(); } catch (_) {}
      } else {
        setStatus("idle");
        setWsStatus("disconnected");
        setIsListening(false);
      }
    };

    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "audio-capture") return;
      console.warn("SpeechRecognition error:", e.error);
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        isOnRef.current = false;
        setIsListening(false);
        setStatus("unsupported");
        setWsStatus("disconnected");
      }
    };

    rec.onresult = (e) => {
      // Stale session guard — discard events from a dead instance
      if (sessionRef.current !== mySession) return;

      let finalChunk = "";
      let interim    = "";

      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          finalChunk += e.results[i][0].transcript;
        } else {
          interim += e.results[i][0].transcript;
        }
      }

      if (finalChunk) {
        const trimmed = finalChunk.trim();
        if (trimmed) {
          setTranscript((prev) => (prev ? `${prev} ${trimmed}` : trimmed));
          pendingRef.current += pendingRef.current ? ` ${trimmed}` : trimmed;
          scheduleFlush();
        }
      }

      setInterimText(interim);
    };

    return rec;
  }

  // ── Toggle listening ──────────────────────────────────────────────────────
  function toggleListening() {
    if (!SR) { setStatus("unsupported"); return; }

    if (isOnRef.current) {
      isOnRef.current = false;
      clearTimers();
      abortCtrlRef.current?.abort();
      pendingRef.current = "";
      sessionRef.current++;
      try { recRef.current?.stop(); } catch (_) {}
      recRef.current = null;
      setIsListening(false);
      setInterimText("");
      setStatus("idle");
      setWsStatus("disconnected");
    } else {
      isOnRef.current     = true;
      lastSentRef.current = "";
      setSuggestion("");

      const rec = buildRecognition();
      if (!rec) { isOnRef.current = false; setStatus("unsupported"); return; }

      recRef.current = rec;
      try { rec.start(); } catch (err) {
        console.error("rec.start() failed:", err);
        isOnRef.current = false;
        setStatus("unsupported");
      }
    }
  }

  // ── Clear transcript ──────────────────────────────────────────────────────
  function clearTranscript() {
    setTranscript("");
    setInterimText("");
    pendingRef.current  = "";
    lastSentRef.current = "";
  }

  const hasSupport = !!SR;

  return (
    <div className="appShell">

      {/* ── Header ── */}
      <header className="appHeader">
        <div className="headerBrand">
          <span className="logo">aico</span>
          <span className="tagline">Realtime Voice Copilot</span>
        </div>

        <div className="headerControls">
          <div className="modeToggle">
            <button
              className={`modeBtn${mode === "proactive" ? " modeActive" : ""}`}
              onClick={() => setMode("proactive")}
            >
              Proactive
            </button>
            <button
              className={`modeBtn${mode === "deep" ? " modeActive" : ""}`}
              onClick={() => setMode("deep")}
            >
              Deep
            </button>
          </div>

          <button
            className={`micBtn${isListening ? " micActive" : ""}${!hasSupport ? " micDisabled" : ""}`}
            onClick={toggleListening}
            disabled={!hasSupport}
            title={!hasSupport ? "Speech Recognition not supported — use Chrome or Edge" : ""}
          >
            <span className="micIcon">{isListening ? "⏹" : "🎙"}</span>
            {isListening ? "Stop" : "Start Listening"}
          </button>
        </div>
      </header>

      {/* ── Status bar ── */}
      <StatusBar status={status} wsStatus={wsStatus} mode={mode} />

      {/* ── Single column stack: Suggestion → Transcript → Context ── */}
      <main className="mainStack">

        {/* 1. Suggestion */}
        <div className="card">
          <div className="cardTitle">
            {mode === "deep" ? "Answer" : "Suggestion"}
          </div>
          <SuggestionPanel
            text={suggestion}
            isListening={isListening}
            status={status}
          />
        </div>

        {/* 2. Live Transcript */}
        <TranscriptPanel
          transcript={transcript}
          interimText={interimText}
          isOpen={transcriptOpen}
          onToggle={() => setTranscriptOpen((v) => !v)}
          onClear={clearTranscript}
          mode={mode}
        />

        {/* 3. Context / Prompt */}
        <div className="card">
          <ChatBox systemPrompt={systemPrompt} setSystemPrompt={setSys} />
        </div>

      </main>

      {!hasSupport && (
        <p className="unsupportedNote">
          ⚠ Speech Recognition is not supported in this browser.
          Please use Chrome or Edge on desktop.
        </p>
      )}
    </div>
  );
}
