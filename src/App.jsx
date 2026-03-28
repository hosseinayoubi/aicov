import { useState, useRef, useCallback } from "react";
import ChatBox from "./components/ChatBox";
import StatusBar from "./components/StatusBar";
import SuggestionPanel from "./components/SuggestionPanel";
import TranscriptPanel from "./components/TranscriptPanel";

// ── Constants ─────────────────────────────────────────────────────────────────
const SILENCE_MS       = 500;
const FAST_FLUSH_WORDS = 8;
const GATE_MS          = { proactive: 3000, deep: 1500 };

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

  // ── Mutable refs (avoid stale closures inside callbacks) ──────────────────
  const recRef          = useRef(null);
  const abortCtrlRef    = useRef(null);
  const silenceTimerRef = useRef(null);
  const gateTimerRef    = useRef(null);
  const pendingRef      = useRef("");   // words accumulated since last flush
  const lastSentRef     = useRef("");   // last text we actually sent to API
  const historyRef      = useRef([]);   // conversation history (server cap = 10)
  const isOnRef         = useRef(false);
  const modeRef         = useRef("proactive");
  const sysRef          = useRef("");

  // ── Sync helpers (state + ref together) ──────────────────────────────────
  const setMode = (m) => { setModeState(m); modeRef.current = m; };
  const setSys  = (s) => { setSysState(s);  sysRef.current  = s; };

  // ── Timer helpers ─────────────────────────────────────────────────────────
  function clearTimers() {
    clearTimeout(silenceTimerRef.current);
    clearTimeout(gateTimerRef.current);
    silenceTimerRef.current = null;
    gateTimerRef.current    = null;
  }

  // ── Flush: send pending text to /api/stream ───────────────────────────────
  const flush = useCallback(async () => {
    const text = pendingRef.current.trim();
    if (!text || text === lastSentRef.current) return;

    pendingRef.current  = "";
    lastSentRef.current = text;

    // Cancel any in-flight request
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
        console.error("Response body is null");
        setStatus("backend_error");
        return;
      }

      setStatus("replying");

      const reader   = res.body.getReader();
      const decoder  = new TextDecoder();
      let   fullText = "";

      // Read streaming plain-text chunks
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        fullText += chunk;
        setSuggestion(fullText);
      }

      // Flush any remaining bytes in decoder
      const tail = decoder.decode();
      if (tail) {
        fullText += tail;
        setSuggestion(fullText);
      }

      // Append to history (server-side caps at 10 messages anyway)
      const trimmed = fullText.trim();
      if (trimmed) {
        historyRef.current = [
          ...historyRef.current,
          { role: "user",      content: text    },
          { role: "assistant", content: trimmed },
        ].slice(-20); // keep last 20 messages client-side
      }

      setStatus(isOnRef.current ? "listening" : "idle");
    } catch (err) {
      if (err?.name === "AbortError") return; // intentional cancel — no-op
      console.error("Fetch failed:", err);
      setStatus("backend_error");
    }
  }, []); // no deps — reads everything via refs

  // ── Schedule flush with silence + gate timers ─────────────────────────────
  function scheduleFlush() {
    clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = null;

    const words = pendingRef.current.trim().split(/\s+/).filter(Boolean).length;

    // Fast-flush when enough words accumulated
    if (words >= FAST_FLUSH_WORDS) {
      clearTimers();
      flush();
      return;
    }

    // Silence timer: flush after N ms of no new speech
    silenceTimerRef.current = setTimeout(() => {
      clearTimers();
      flush();
    }, SILENCE_MS);

    // Gate timer: hard max wait before first flush in this utterance
    if (!gateTimerRef.current) {
      gateTimerRef.current = setTimeout(() => {
        clearTimers();
        flush();
      }, GATE_MS[modeRef.current] ?? 3000);
    }
  }

  // ── Build SpeechRecognition instance ─────────────────────────────────────
  function buildRecognition() {
    if (!SR) return null;

    const rec           = new SR();
    rec.continuous      = true;
    rec.interimResults  = true;
    rec.lang            = "en-US";
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      setStatus("listening");
      setWsStatus("connected");
      setIsListening(true);
    };

    rec.onend = () => {
      // Auto-restart while user wants to keep listening
      if (isOnRef.current) {
        try { rec.start(); } catch (_) {}
      } else {
        setStatus("idle");
        setWsStatus("disconnected");
        setIsListening(false);
      }
    };

    rec.onerror = (e) => {
      // Benign errors — just silence or mic unavailable briefly
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

  // ── Toggle listening on/off ───────────────────────────────────────────────
  function toggleListening() {
    if (!SR) {
      setStatus("unsupported");
      return;
    }

    if (isOnRef.current) {
      // ── STOP ──
      isOnRef.current = false;
      clearTimers();
      abortCtrlRef.current?.abort();
      pendingRef.current = "";

      try { recRef.current?.stop(); } catch (_) {}
      recRef.current = null;

      setIsListening(false);
      setInterimText("");
      setStatus("idle");
      setWsStatus("disconnected");
    } else {
      // ── START ──
      isOnRef.current     = true;
      lastSentRef.current = "";
      setSuggestion("");

      const rec = buildRecognition();
      if (!rec) {
        isOnRef.current = false;
        setStatus("unsupported");
        return;
      }

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

  // ── Render ────────────────────────────────────────────────────────────────
  const hasSupport = !!SR;

  return (
    <div className="appShell">

      {/* ── Header ── */}
      <header className="appHeader">
        <div className="headerBrand">
          <span className="logo">aico</span>
          <span className="tagline">Realtime Voice Copilot</span>
        </div>

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
      </header>

      {/* ── Status bar ── */}
      <StatusBar status={status} wsStatus={wsStatus} mode={mode} />

      {/* ── Main grid ── */}
      <main className="mainGrid">

        {/* Left column */}
        <div className="col">
          <div className="card">
            <ChatBox systemPrompt={systemPrompt} setSystemPrompt={setSys} />
          </div>

          <button
            className={`micBtn${isListening ? " micActive" : ""}${!hasSupport ? " micDisabled" : ""}`}
            onClick={toggleListening}
            disabled={!hasSupport}
            title={!hasSupport ? "Speech Recognition not supported — use Chrome or Edge on desktop" : ""}
          >
            <span className="micIcon">{isListening ? "⏹" : "🎙"}</span>
            {isListening ? "Stop Listening" : "Start Listening"}
          </button>

          {!hasSupport && (
            <p className="unsupportedNote">
              ⚠ Speech Recognition is not supported in this browser.
              Please use Chrome or Edge on desktop.
            </p>
          )}
        </div>

        {/* Right column */}
        <div className="col">
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

          <TranscriptPanel
            transcript={transcript}
            interimText={interimText}
            isOpen={transcriptOpen}
            onToggle={() => setTranscriptOpen((v) => !v)}
            onClear={clearTranscript}
            mode={mode}
          />
        </div>

      </main>
    </div>
  );
}
