import { useEffect, useMemo, useRef, useState } from "react";
import StatusBar from "./components/StatusBar.jsx";
import SuggestionPanel from "./components/SuggestionPanel.jsx";
import ChatBox from "./components/ChatBox.jsx";

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

const AUTO_STOP_MS = 2 * 60 * 1000; // 2 minutes

export default function App() {
  const [status, setStatus]           = useState("idle");
  const [wsStatus, setWsStatus]       = useState("connected");
  const [systemPrompt, setSystemPrompt] = useState("You are a proactive AI copilot.");
  const [mode, setMode]               = useState("proactive");
  const [showLive, setShowLive]       = useState(true);
  const [finalText, setFinalText]     = useState("");
  const [interimText, setInterimText] = useState("");
  const [reply, setReply]             = useState("");
  const [liveReply, setLiveReply]     = useState("");
  const [isListening, setIsListening] = useState(false);

  // ── Refs to prevent stale closures inside async / event handlers ──
  const isListeningRef   = useRef(false);
  const showLiveRef      = useRef(true);
  const modeRef          = useRef("proactive");
  const systemPromptRef  = useRef("You are a proactive AI copilot.");

  const recognitionRef      = useRef(null);
  const bufferFinalRef      = useRef("");
  const lastSentHashRef     = useRef("");
  const shortSilenceTimerRef = useRef(null);
  const longGateTimerRef    = useRef(null);
  const typeTimerRef        = useRef(null);
  const lastRequestIdRef    = useRef("");
  const abortRef            = useRef(null);
  const autoStopTimerRef    = useRef(null);

  // Keep refs in sync
  useEffect(() => { isListeningRef.current = isListening; }, [isListening]);
  useEffect(() => { showLiveRef.current = showLive; if (!showLive) setInterimText(""); }, [showLive]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { systemPromptRef.current = systemPrompt; }, [systemPrompt]);

  // ── Timers ──────────────────────────────────────────────────────────
  function clearAdaptiveTimers() {
    clearTimeout(shortSilenceTimerRef.current);
    clearTimeout(longGateTimerRef.current);
    shortSilenceTimerRef.current = null;
    longGateTimerRef.current     = null;
  }

  function resetAutoStop() {
    clearTimeout(autoStopTimerRef.current);
    autoStopTimerRef.current = setTimeout(() => {
      if (!isListeningRef.current) return;
      // Inline stop (avoids stale closure on stopListening)
      isListeningRef.current = false;
      setIsListening(false);
      setStatus("idle");
      clearAdaptiveTimers();
      bufferFinalRef.current = "";
      try { recognitionRef.current?.stop?.(); } catch {}
    }, AUTO_STOP_MS);
  }

  // ── Typewriter effect ───────────────────────────────────────────────
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
    }, 30);
  }

  // ── Backend streaming ───────────────────────────────────────────────
  async function sendToBackend(text) {
    const clean = String(text || "").trim();
    if (!clean) return;

    const h = hashText(clean);
    if (h === lastSentHashRef.current) return;
    lastSentHashRef.current = h;

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current  = controller;
    const requestId   = makeId();
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

  // ── Adaptive send scheduler ─────────────────────────────────────────
  function scheduleAdaptiveFlush() {
    if (!(bufferFinalRef.current || "").trim()) return;
    clearAdaptiveTimers();

    // Fast path: send after 700ms pause
    shortSilenceTimerRef.current = setTimeout(() => {
      const t = (bufferFinalRef.current || "").trim();
      if (t) { bufferFinalRef.current = ""; sendToBackend(t); }
    }, 700);

    // Fallback gate
    longGateTimerRef.current = setTimeout(() => {
      const t = (bufferFinalRef.current || "").trim();
      if (t) { bufferFinalRef.current = ""; sendToBackend(t); }
    }, modeRef.current === "proactive" ? 5000 : 2000);
  }

  // ── Speech Recognition ──────────────────────────────────────────────
  function initSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setStatus("unsupported"); return; }

    const rec = new SR();
    rec.continuous     = true;
    rec.interimResults = true;
    rec.lang           = "en-US";

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
        setFinalText((prev) => (prev ? prev + " " + cleanFinal : cleanFinal).trim());
        bufferFinalRef.current = (bufferFinalRef.current + " " + cleanFinal).trim();
        scheduleAdaptiveFlush();
        resetAutoStop();
      }
      setInterimText(showLiveRef.current ? cleanInterim : "");
    };

    rec.onerror = (e) => {
      console.error("Speech error:", e.error);
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setStatus("unsupported");
        setIsListening(false);
        isListeningRef.current = false;
      }
      // 'no-speech' is expected during silence – let onend handle restart
    };

    rec.onend = () => {
      // Chrome stops recognition after pauses; restart if still listening
      if (isListeningRef.current) {
        try { rec.start(); } catch {}
      }
    };

    recognitionRef.current = rec;
  }

  useEffect(() => {
    initSpeech();
    return () => {
      isListeningRef.current = false;
      try { recognitionRef.current?.stop?.(); } catch {}
      if (abortRef.current) abortRef.current.abort();
      clearAdaptiveTimers();
      clearInterval(typeTimerRef.current);
      clearTimeout(autoStopTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Controls ────────────────────────────────────────────────────────
  function startListening() {
    if (!recognitionRef.current) return;
    setFinalText("");
    setInterimText("");
    bufferFinalRef.current   = "";
    lastSentHashRef.current  = "";
    clearAdaptiveTimers();
    setReply("");
    setLiveReply("");
    setStatus("listening");
    setIsListening(true);
    isListeningRef.current = true;
    resetAutoStop();
    try { recognitionRef.current.start(); } catch {}
  }

  function stopListening() {
    isListeningRef.current = false;
    setIsListening(false);
    setStatus("idle");
    clearAdaptiveTimers();
    clearTimeout(autoStopTimerRef.current);
    const t = (bufferFinalRef.current || "").trim();
    bufferFinalRef.current = "";
    if (t) sendToBackend(t);
    try { recognitionRef.current?.stop?.(); } catch {}
  }

  const transcriptToShow = useMemo(() => {
    if (showLive) return [finalText, interimText].filter(Boolean).join(" ").trim();
    return finalText;
  }, [finalText, interimText, showLive]);

  const unsupported = status === "unsupported";

  // ── Render ──────────────────────────────────────────────────────────
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
          <label className="toggle">
            <input
              type="checkbox"
              checked={showLive}
              onChange={(e) => setShowLive(e.target.checked)}
            />
            <span className="toggleTrack" />
            <span className="toggleLabel">Live transcript</span>
          </label>
        </div>
      </div>

      {/* ── Status bar ── */}
      <StatusBar status={status} wsStatus={wsStatus} mode={mode} />

      {/* ── Context / Prompt ── */}
      <div className="card">
        <ChatBox systemPrompt={systemPrompt} setSystemPrompt={setSystemPrompt} />
      </div>

      {/* ── Live transcript ── */}
      <div className="card">
        <div className="cardTitle">Live transcript</div>
        <div className="transcriptBox">
          {transcriptToShow || <span className="placeholder">Say something…</span>}
        </div>
        <div className="hint">
          Adaptive: pauses send faster. Fallback gate: ~5s in proactive.
        </div>
      </div>

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
          <>
            <button
              className={`btn${isListening ? " btnStop" : " btnStart"}`}
              onClick={isListening ? stopListening : startListening}
            >
              {isListening ? "Stop" : "Start"}
            </button>
          </>
        )}
        <div className="meta">
          <span>aico.weomeo.win</span>
          <span>Auto-stop: 2 minutes silence</span>
        </div>
      </div>

    </div>
  );
}
