import { useEffect, useRef, useState } from "react";
import StatusBar from "./components/StatusBar.jsx";
import SuggestionPanel from "./components/SuggestionPanel.jsx";
import ChatBox from "./components/ChatBox.jsx";
import TranscriptPanel from "./components/TranscriptPanel.jsx";

/* ── Helpers ──────────────────────────────────────────────────────────── */
function makeId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

// FNV-1a hash — fast, stable dedupe key
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
// From App.jsx (fastest, most responsive)
const SILENCE_MS         = 280;   // ms of speech silence before flushing
const FAST_FLUSH_WORDS   = 5;     // flush immediately at this many words
const GATE_MS            = { proactive: 1800, deep: 900 }; // hard-max wait

const AUTO_STOP_MS        = 2 * 60 * 1000; // 2-minute auto-stop
const RESTART_DEBOUNCE_MS = 100;            // gap before re-starting recognition
const MAX_HISTORY_TURNS   = 3;              // conversation turns to keep

// VAD (Web Audio API — real silence detection, beats timer-only approach)
const VAD_INTERVAL_MS = 50;
const VAD_THRESHOLD   = 0.012; // RMS — raise if ambient noise triggers false flushes
const VAD_SILENCE_MS  = 550;   // ms of audio silence before VAD fires

/* ─────────────────────────────────────────────────────────────────────── */

export default function App() {
  /* ── UI state ── */
  const [status,         setStatus]         = useState("idle");
  const [wsStatus,       setWsStatus]       = useState("connected");
  const [systemPrompt,   setSystemPrompt]   = useState("You are a proactive AI copilot.");
  const [mode,           setMode]           = useState("proactive");
  const [showLive,       setShowLive]       = useState(true);
  const [transcriptOpen, setTranscriptOpen] = useState(true);
  const [finalText,      setFinalText]      = useState("");
  const [interimText,    setInterimText]    = useState("");
  const [reply,          setReply]          = useState("");
  const [liveReply,      setLiveReply]      = useState("");
  const [isListening,    setIsListening]    = useState(false);

  /* ── Refs — avoid stale closures in async / event handlers ── */
  const isListeningRef  = useRef(false);
  const modeRef         = useRef("proactive");
  const systemPromptRef = useRef("You are a proactive AI copilot.");
  const showLiveRef     = useRef(true);

  // Speech recognition
  const recognitionRef  = useRef(null);
  const recActiveRef    = useRef(false);

  // ▶ Session counter — prevents stale onresult from a recycled SR instance
  //   from firing duplicate words after auto-restart (from App.jsx)
  const sessionRef      = useRef(0);

  // Text pipeline
  const bufferFinalRef  = useRef("");
  const lastSentHashRef = useRef("");

  // Request tracking
  const lastRequestIdRef = useRef("");
  const abortRef         = useRef(null);

  // Pending queue — speech heard WHILE replying waits here instead of
  // aborting the in-flight reply (from App 2/3/4)
  const pendingTextRef  = useRef("");
  const isReplyingRef   = useRef(false);

  // Conversation history (resets each session start)
  const historyRef = useRef([]);

  // Timers
  const silenceTimerRef  = useRef(null);
  const gateTimerRef     = useRef(null);
  const typeTimerRef     = useRef(null);
  const autoStopTimerRef = useRef(null);
  const restartTimerRef  = useRef(null);

  // VAD (Web Audio API)
  const audioCtxRef       = useRef(null);
  const analyserRef       = useRef(null);
  const micStreamRef      = useRef(null);
  const vadLoopRef        = useRef(null);
  const lastSpeechTimeRef = useRef(0);
  const vadFlushedRef     = useRef(false);

  // Stable refs so Space-key handler always calls the latest fn
  const startListeningRef = useRef(null);
  const stopListeningRef  = useRef(null);

  /* ── Sync refs with state ── */
  useEffect(() => { isListeningRef.current  = isListening;  }, [isListening]);
  useEffect(() => { modeRef.current         = mode;         }, [mode]);
  useEffect(() => { systemPromptRef.current = systemPrompt; }, [systemPrompt]);
  useEffect(() => { showLiveRef.current     = showLive;     }, [showLive]);

  /* ── Timer helpers ── */
  function clearFlushTimers() {
    clearTimeout(silenceTimerRef.current);
    clearTimeout(gateTimerRef.current);
    silenceTimerRef.current = null;
    gateTimerRef.current    = null;
  }

  function resetAutoStop() {
    clearTimeout(autoStopTimerRef.current);
    autoStopTimerRef.current = setTimeout(() => {
      if (!isListeningRef.current) return;
      // Inline stop avoids stale closure issues
      isListeningRef.current = false;
      recActiveRef.current   = false;
      setIsListening(false);
      setStatus("idle");
      clearFlushTimers();
      bufferFinalRef.current = "";
      pendingTextRef.current = "";
      stopVAD();
      try { recognitionRef.current?.stop?.(); } catch {}
    }, AUTO_STOP_MS);
  }

  /* ── Typewriter effect ── */
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

    // Hash dedup: prevents double-sending the same burst.
    // Cleared in finally so the user can repeat the same sentence later.
    const h = hashText(clean);
    if (h === lastSentHashRef.current) return;
    lastSentHashRef.current = h;

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId  = makeId();
    lastRequestIdRef.current = requestId;

    isReplyingRef.current = true;
    setStatus("thinking");
    setWsStatus("connected");
    setReply("");
    setLiveReply("");

    const history = historyRef.current.slice(-(MAX_HISTORY_TURNS * 2));

    try {
      const res = await fetch("/api/stream", {
        method : "POST",
        headers: { "Content-Type": "application/json" },
        body   : JSON.stringify({
          text   : clean,
          system : systemPromptRef.current,
          mode   : modeRef.current,
          history,
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
        // Stale request guard — a newer request has taken over
        if (lastRequestIdRef.current !== requestId) return;
        acc += chunk;
        setLiveReply(acc);
      }

      if (lastRequestIdRef.current !== requestId) return;

      const final = String(acc || "").trim();
      if (final) {
        historyRef.current = [
          ...historyRef.current,
          { role: "user",      content: clean },
          { role: "assistant", content: final },
        ];
      }

      setReply(final);
      startTypeReply(final);
      setStatus(isListeningRef.current ? "listening" : "idle");

    } catch (e) {
      if (e?.name === "AbortError") return;
      console.error("Fetch failed:", e);
      setWsStatus("error");
      setStatus("backend_error");

    } finally {
      // ── Race Condition Guard (from App 2/3) ──────────────────────────
      // finally runs even for return'd / aborted requests.
      // Without this guard an old request's finally would corrupt
      // isReplyingRef and pendingTextRef that belong to the new request.
      // Only clean up if THIS request is still the active one.
      // ─────────────────────────────────────────────────────────────────
      if (lastRequestIdRef.current === requestId) {
        // Reset hash in BOTH success and error paths so the user can
        // repeat a sentence after a failed request (App 2 fix).
        lastSentHashRef.current = "";
        isReplyingRef.current   = false;

        // If speech arrived while we were replying, process it now.
        const pending = pendingTextRef.current.trim();
        pendingTextRef.current = "";
        if (pending) sendToBackend(pending);
      }
    }
  }

  /* ── Flush buffer ── */
  function flushBuffer() {
    const t = (bufferFinalRef.current || "").trim();
    if (!t) return;
    bufferFinalRef.current = "";
    vadFlushedRef.current  = true;
    clearFlushTimers();

    if (isReplyingRef.current) {
      // Reply still streaming — queue instead of aborting (App 2/3/4)
      pendingTextRef.current = (pendingTextRef.current + " " + t).trim();
      return;
    }

    sendToBackend(t);
  }

  /* ── Adaptive flush scheduler (from App.jsx — fastest timing) ── */
  function scheduleFlush() {
    clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = null;

    const words = (bufferFinalRef.current || "").trim().split(/\s+/).filter(Boolean).length;

    // Immediate flush if threshold reached
    if (words >= FAST_FLUSH_WORDS) {
      clearFlushTimers();
      flushBuffer();
      return;
    }

    // Silence timer: flush after N ms of no new speech
    silenceTimerRef.current = setTimeout(() => {
      clearFlushTimers();
      flushBuffer();
    }, SILENCE_MS);

    // Gate timer: hard-max wait, set only once per utterance
    if (!gateTimerRef.current) {
      gateTimerRef.current = setTimeout(() => {
        gateTimerRef.current = null;
        flushBuffer();
      }, GATE_MS[modeRef.current] ?? 1800);
    }
  }

  /* ── VAD (Web Audio API) ── */
  // Accepts an optional existing stream to avoid a second getUserMedia call.
  // Called with await so its mic grant resolves BEFORE SpeechRecognition
  // grabs the mic — prevents Chrome audio pipeline conflict (App 5/6 fix).
  async function startVAD(existingStream) {
    try {
      const stream = existingStream || await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      micStreamRef.current = stream;

      const ctx      = new (window.AudioContext || window.webkitAudioContext)();
      const source   = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize               = 512;
      analyser.smoothingTimeConstant = 0.3;
      source.connect(analyser);
      audioCtxRef.current       = ctx;
      analyserRef.current       = analyser;
      lastSpeechTimeRef.current = Date.now();
      vadFlushedRef.current     = false;

      clearInterval(vadLoopRef.current);
      vadLoopRef.current = setInterval(() => {
        if (!isListeningRef.current) return;
        const an = analyserRef.current;
        if (!an) return;

        const data = new Uint8Array(an.frequencyBinCount);
        an.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);

        if (rms > VAD_THRESHOLD) {
          lastSpeechTimeRef.current = Date.now();
          vadFlushedRef.current     = false;
        } else {
          const silMs = Date.now() - lastSpeechTimeRef.current;
          if (
            silMs >= VAD_SILENCE_MS &&
            !vadFlushedRef.current &&
            (bufferFinalRef.current || "").trim()
          ) {
            flushBuffer();
          }
        }
      }, VAD_INTERVAL_MS);
    } catch (e) {
      // Mic denied or API unavailable — timer-based flush still works
      console.warn("VAD init failed:", e);
    }
  }

  function stopVAD() {
    clearInterval(vadLoopRef.current);
    vadLoopRef.current = null;
    try { micStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
    try { audioCtxRef.current?.close(); } catch {}
    micStreamRef.current = null;
    audioCtxRef.current  = null;
    analyserRef.current  = null;
  }

  /* ── Safe SR start (prevents double-start) ── */
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

  /* ── Speech Recognition init ── */
  function initSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setStatus("unsupported"); return; }

    const rec           = new SR();
    rec.continuous      = true;
    rec.interimResults  = true;
    rec.lang            = "en-US";
    rec.maxAlternatives = 1;

    // Snapshot session at creation — stale-event guard (from App.jsx)
    const mySession = ++sessionRef.current;

    rec.onstart = () => { recActiveRef.current = true; };

    rec.onresult = (e) => {
      // Discard events from a recycled (dead) SR instance — kills duplicate words
      if (sessionRef.current !== mySession) return;

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
        vadFlushedRef.current = false;
        scheduleFlush();
        resetAutoStop();
      }
      setInterimText(showLiveRef.current ? cleanInterim : "");
    };

    rec.onerror = (e) => {
      console.warn("Speech error:", e.error);
      recActiveRef.current = false;

      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setStatus("unsupported");
        setIsListening(false);
        isListeningRef.current = false;
        stopVAD();
        return;
      }
      // "no-speech", "audio-capture", "network" → onend will handle restart
      if (e.error === "audio-capture") {
        console.warn("Audio capture conflict — will retry via onend");
      }
    };

    rec.onend = () => {
      recActiveRef.current = false;
      if (!isListeningRef.current) return;
      // Invalidate stale events from this instance before restarting (App.jsx)
      sessionRef.current++;
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
      sessionRef.current++;
      clearTimeout(restartTimerRef.current);
      stopVAD();
      if (abortRef.current) abortRef.current.abort();
      clearFlushTimers();
      clearInterval(typeTimerRef.current);
      clearTimeout(autoStopTimerRef.current);
      try { recognitionRef.current?.stop?.(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Controls ── */
  async function startListening() {
    if (!recognitionRef.current) return;

    // Full reset
    setFinalText("");
    setInterimText("");
    bufferFinalRef.current  = "";
    lastSentHashRef.current = "";
    pendingTextRef.current  = "";
    historyRef.current      = [];
    clearFlushTimers();
    setReply("");
    setLiveReply("");
    setStatus("listening");
    setIsListening(true);
    isListeningRef.current = true;
    resetAutoStop();

    // Stop any running VAD first to prevent double intervals (App 3 fix)
    stopVAD();
    // Await VAD so its getUserMedia resolves BEFORE SR grabs the mic.
    // Calling both simultaneously caused a Chrome audio pipeline conflict (App 5/6 fix).
    await startVAD();
    safeStart();
  }

  function stopListening() {
    isListeningRef.current = false;
    recActiveRef.current   = false;
    sessionRef.current++;
    setIsListening(false);
    setStatus("idle");
    clearFlushTimers();
    clearTimeout(autoStopTimerRef.current);
    clearTimeout(restartTimerRef.current);

    // Flush remaining buffer one last time
    const t = (bufferFinalRef.current || "").trim();
    bufferFinalRef.current = "";
    pendingTextRef.current = "";
    if (t) sendToBackend(t);

    stopVAD();
    try { recognitionRef.current?.stop?.(); } catch {}
  }

  function clearTranscript() {
    setFinalText("");
    setInterimText("");
    bufferFinalRef.current  = "";
    lastSentHashRef.current = "";
  }

  /* ── Space key shortcut ── */
  startListeningRef.current = startListening;
  stopListeningRef.current  = stopListening;

  useEffect(() => {
    function onKeyDown(e) {
      if (e.code !== "Space") return;
      const tag = document.activeElement?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      e.preventDefault();
      if (isListeningRef.current) stopListeningRef.current?.();
      else startListeningRef.current?.();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
          <label className="toggle">
            <input
              type="checkbox"
              checked={showLive}
              onChange={(e) => {
                const val = e.target.checked;
                setShowLive(val);
                setTranscriptOpen(val);
              }}
            />
            <span className="toggleTrack" />
            <span className="toggleLabel">Live transcript</span>
          </label>
        </div>
      </div>

      {/* ── Status bar ── */}
      <StatusBar status={status} wsStatus={wsStatus} mode={mode} />

      {/* ── Suggestion (first — most important content) ── */}
      <div className="card">
        <div className="cardTitle">
          {mode === "deep" ? "Answer" : "Suggestion"}
        </div>
        <SuggestionPanel
          text={liveReply || reply}
          isListening={isListening}
          status={status}
        />
      </div>

      {/* ── Live transcript — collapsible drawer ── */}
      <TranscriptPanel
        transcript={finalText}
        interimText={showLive ? interimText : ""}
        isOpen={transcriptOpen}
        onToggle={() => setTranscriptOpen((o) => !o)}
        onClear={clearTranscript}
        mode={mode}
      />

      {/* ── Context / System Prompt ── */}
      <div className="card">
        <ChatBox systemPrompt={systemPrompt} setSystemPrompt={setSystemPrompt} />
      </div>

      {/* ── Footer / Start-Stop ── */}
      <div className="bottomBar">
        {unsupported ? (
          <span className="unsupportedNote">
            ⚠️ Speech recognition not supported — use Chrome or Edge on desktop.
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
          <span>Space to toggle · Auto-stop: 2 min</span>
        </div>
      </div>

    </div>
  );
}
