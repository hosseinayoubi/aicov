import { useEffect, useRef, useState } from "react";
import StatusBar from "./components/StatusBar.jsx";
import ConversationLog from "./components/ConversationLog.jsx";
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

/* ── Platform detection ───────────────────────────────────────────────── */
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(
  typeof navigator !== "undefined" ? navigator.userAgent : ""
);

/* ── Tuning constants ─────────────────────────────────────────────────── */
// Accuracy > speed — give SR more time to finalize words before flushing.
// Mobile needs even more time because the SR engine is slower and the OS
// may need longer to settle between mic-stop and mic-start cycles.
const SILENCE_MS       = IS_MOBILE ? 900  : 600;   // ms of silence → flush
const FAST_FLUSH_WORDS = IS_MOBILE ? 10   : 8;     // immediate flush at N words
const GATE_MS          = IS_MOBILE
  ? { proactive: 3000, deep: 2000 }   // mobile: patience pays off
  : { proactive: 2000, deep: 1200 };  // desktop: still comfortable

const AUTO_STOP_MS        = 2 * 60 * 1000;
const RESTART_DEBOUNCE_MS = IS_MOBILE ? 600 : 120;  // OS mic-release time
const MAX_HISTORY_TURNS   = 3;
const MAX_LOG_ENTRIES     = 6; // max conversation entries to keep visible

// VAD — desktop only (mobile: double getUserMedia kills SR — see startVAD)
const VAD_INTERVAL_MS = 50;
const VAD_THRESHOLD   = 0.012;
const VAD_SILENCE_MS  = 800;

/* ─────────────────────────────────────────────────────────────────────── */

export default function App() {
  /* ── UI state ── */
  const [status,             setStatus]             = useState("idle");
  const [wsStatus,           setWsStatus]           = useState("connected");
  const [systemPrompt,       setSystemPrompt]       = useState("You are a proactive AI copilot.");
  const [mode,               setMode]               = useState("proactive");
  const [showLive,           setShowLive]           = useState(true);
  const [transcriptOpen,     setTranscriptOpen]     = useState(true);
  const [transcriptAnimated, setTranscriptAnimated] = useState(false);
  const [finalText,          setFinalText]          = useState("");
  const [interimText,        setInterimText]        = useState("");
  const [isListening,        setIsListening]        = useState(false);

  // Conversation log: replaces single reply/liveReply.
  // Entries persist for the whole session so the user can read them.
  // Each entry: {id, question, answer, streaming, mode}
  const [conversationLog, setConversationLog] = useState([]);

  /* ── Refs ── */
  const isListeningRef  = useRef(false);
  const modeRef         = useRef("proactive");
  const systemPromptRef = useRef("You are a proactive AI copilot.");
  const showLiveRef     = useRef(true);

  const recognitionRef = useRef(null);
  const recActiveRef   = useRef(false);
  const sessionRef     = useRef(0);

  // ── Duplicate-word guard ─────────────────────────────────────────────
  // Chrome mobile (and occasionally desktop) re-delivers already-processed
  // final results when recognition restarts internally with continuous=true.
  // e.resultIndex should protect against this, but on mobile Chrome it
  // sometimes resets to 0 after an internal restart.
  // Fix: track the highest final result index we've already processed.
  // In onresult, only process finals at index >= processedFinalCountRef.
  const processedFinalCountRef = useRef(0);

  const bufferFinalRef   = useRef("");
  const lastSentHashRef  = useRef("");
  const lastRequestIdRef = useRef("");
  const abortRef         = useRef(null);

  const pendingTextRef = useRef("");
  const isReplyingRef  = useRef(false);
  const historyRef     = useRef([]);

  const silenceTimerRef  = useRef(null);
  const gateTimerRef     = useRef(null);
  const autoStopTimerRef = useRef(null);
  const restartTimerRef  = useRef(null);

  // VAD (desktop only)
  const audioCtxRef       = useRef(null);
  const analyserRef       = useRef(null);
  const micStreamRef      = useRef(null);
  const vadLoopRef        = useRef(null);
  const lastSpeechTimeRef = useRef(0);
  const vadFlushedRef     = useRef(false);

  // Stable fn refs (used by effects + visibilitychange handler)
  const startListeningRef   = useRef(null);
  const stopListeningRef    = useRef(null);
  const buildRecognitionRef = useRef(null);
  const safeStartRef        = useRef(null);

  /* ── Sync refs ── */
  useEffect(() => { isListeningRef.current  = isListening;  }, [isListening]);
  useEffect(() => { modeRef.current         = mode;         }, [mode]);
  useEffect(() => { systemPromptRef.current = systemPrompt; }, [systemPrompt]);
  useEffect(() => { showLiveRef.current     = showLive;     }, [showLive]);

  /* ── Drawer animation: enable only after first paint ── */
  useEffect(() => {
    const id = requestAnimationFrame(() => setTranscriptAnimated(true));
    return () => cancelAnimationFrame(id);
  }, []);

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

  /* ── Backend streaming ────────────────────────────────────────────────
     Each call creates a NEW entry in conversationLog so answers accumulate
     and stay visible. The user can read previous answers while new ones
     stream in. No typewriter effect — text appears directly as it streams
     so the user sees words as fast as the model produces them.
  ── */
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
    const entryMode = modeRef.current; // capture at call time

    isReplyingRef.current = true;
    setStatus("thinking");
    setWsStatus("connected");

    // Add a new streaming entry to the log (cap at MAX_LOG_ENTRIES)
    setConversationLog(prev => [
      ...prev.slice(-(MAX_LOG_ENTRIES - 1)),
      { id: requestId, question: clean, answer: "", streaming: true, mode: entryMode },
    ]);

    const history = historyRef.current.slice(-(MAX_HISTORY_TURNS * 2));

    try {
      const res = await fetch("/api/stream", {
        method : "POST",
        headers: { "Content-Type": "application/json" },
        body   : JSON.stringify({
          text   : clean,
          system : systemPromptRef.current,
          mode   : entryMode,
          history,
          requestId,
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        setWsStatus("error");
        setStatus("backend_error");
        // Mark entry as failed
        setConversationLog(prev => prev.map(e =>
          e.id === requestId ? { ...e, streaming: false, answer: e.answer || "⚠ Error" } : e
        ));
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
        // Update the streaming entry in real time
        setConversationLog(prev => prev.map(e =>
          e.id === requestId ? { ...e, answer: acc } : e
        ));
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

      // Mark entry as complete (stops the streaming indicator)
      setConversationLog(prev => prev.map(e =>
        e.id === requestId ? { ...e, answer: final, streaming: false } : e
      ));
      setStatus(isListeningRef.current ? "listening" : "idle");

    } catch (e) {
      if (e?.name === "AbortError") return;
      console.error("Fetch failed:", e);
      setWsStatus("error");
      setStatus("backend_error");
      setConversationLog(prev => prev.map(e =>
        e.id === requestId ? { ...e, streaming: false } : e
      ));

    } finally {
      if (lastRequestIdRef.current === requestId) {
        lastSentHashRef.current = "";
        isReplyingRef.current   = false;
        const pending = pendingTextRef.current.trim();
        pendingTextRef.current = "";
        if (pending) sendToBackend(pending);
      }
    }
  }

  /* ── Buffer flush ── */
  function flushBuffer() {
    const t = (bufferFinalRef.current || "").trim();
    if (!t) return;
    bufferFinalRef.current = "";
    vadFlushedRef.current  = true;
    clearFlushTimers();
    if (isReplyingRef.current) {
      pendingTextRef.current = (pendingTextRef.current + " " + t).trim();
      return;
    }
    sendToBackend(t);
  }

  function scheduleFlush() {
    clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = null;

    const words = (bufferFinalRef.current || "").trim().split(/\s+/).filter(Boolean).length;
    if (words >= FAST_FLUSH_WORDS) {
      clearFlushTimers();
      flushBuffer();
      return;
    }

    silenceTimerRef.current = setTimeout(() => {
      clearFlushTimers();
      flushBuffer();
    }, SILENCE_MS);

    if (!gateTimerRef.current) {
      gateTimerRef.current = setTimeout(() => {
        gateTimerRef.current = null;
        flushBuffer();
      }, GATE_MS[modeRef.current] ?? 2000);
    }
  }

  /* ── VAD (desktop only) ───────────────────────────────────────────────
     On mobile, VAD calls getUserMedia which conflicts with SpeechRecognition's
     own internal getUserMedia. The mic is exclusive on mobile — whichever
     grabs it first works, the other silently fails. Result: no audio captured.
     On desktop both can share the stream without conflict.
     Mobile uses timer-only flush (SILENCE_MS + GATE_MS above). ── */
  async function startVAD() {
    if (IS_MOBILE) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
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
          if (silMs >= VAD_SILENCE_MS && !vadFlushedRef.current && (bufferFinalRef.current || "").trim()) {
            flushBuffer();
          }
        }
      }, VAD_INTERVAL_MS);
    } catch (e) {
      console.warn("VAD init failed (timer flush still active):", e);
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

  /* ── Safe SR start ── */
  function safeStart() {
    if (!recognitionRef.current || recActiveRef.current) return;
    recActiveRef.current = true;
    try {
      recognitionRef.current.start();
    } catch (e) {
      recActiveRef.current = false;
      console.warn("rec.start() error:", e);
      if (isListeningRef.current) {
        clearTimeout(restartTimerRef.current);
        restartTimerRef.current = setTimeout(() => {
          if (isListeningRef.current) safeStartRef.current?.();
        }, RESTART_DEBOUNCE_MS);
      }
    }
  }

  /* ── Build fresh SpeechRecognition ────────────────────────────────────
     Called at every startListening. mySession = sessionRef.current at
     creation time. Events from old (superseded) instances are discarded
     by the "if (sessionRef.current !== mySession) return" guard.
  ── */
  function buildRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setStatus("unsupported"); return false; }

    try { recognitionRef.current?.stop?.(); } catch {}
    recActiveRef.current = false;

    const rec           = new SR();
    rec.continuous      = true;
    rec.interimResults  = true;
    rec.lang            = "en-US";
    rec.maxAlternatives = 1;

    const mySession = sessionRef.current;

    rec.onstart = () => { recActiveRef.current = true; };

    rec.onresult = (e) => {
      if (sessionRef.current !== mySession) return;

      let interim  = "";
      let newFinal = "";

      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const t = r?.[0]?.transcript || "";

        if (r.isFinal) {
          // ── Duplicate-word guard ─────────────────────────────────────
          // Skip any final result we've already processed. Chrome mobile
          // sometimes resets resultIndex to 0 after an internal restart,
          // re-delivering all previous finals. processedFinalCountRef
          // tracks the highest processed index so we never double-count.
          if (i < processedFinalCountRef.current) continue;
          processedFinalCountRef.current = i + 1;
          newFinal += " " + t;
        } else {
          interim += " " + t;
        }
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

      // audio-capture: mic busy. Some browsers don't fire onend after this.
      // Schedule an explicit retry so we never get stuck.
      if (e.error === "audio-capture") {
        clearTimeout(restartTimerRef.current);
        restartTimerRef.current = setTimeout(() => {
          if (isListeningRef.current && sessionRef.current === mySession) {
            safeStartRef.current?.();
          }
        }, IS_MOBILE ? 1200 : 500);
        return;
      }
      // All other errors: onend will fire → normal restart path handles it.
    };

    rec.onend = () => {
      recActiveRef.current = false;
      if (!isListeningRef.current) return;
      // Do NOT increment sessionRef — within-session restart, mySession stays valid.
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = setTimeout(() => {
        if (isListeningRef.current && sessionRef.current === mySession) {
          safeStartRef.current?.();
        }
      }, RESTART_DEBOUNCE_MS);
    };

    recognitionRef.current = rec;
    return true;
  }

  /* ── Mount: check support + cleanup ── */
  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) setStatus("unsupported");

    return () => {
      isListeningRef.current = false;
      recActiveRef.current   = false;
      sessionRef.current++;
      clearTimeout(restartTimerRef.current);
      stopVAD();
      if (abortRef.current) abortRef.current.abort();
      clearFlushTimers();
      clearTimeout(autoStopTimerRef.current);
      try { recognitionRef.current?.stop?.(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Mobile: screen-lock / app-background recovery ───────────────────
     When phone screen locks or user switches apps, SR stops. onend fires
     and the normal restart loop runs — but on some mobile browsers,
     start() silently fails while the screen is locked. When the user
     returns, isListening is true but recActive is false and nothing works.
     visibilitychange catches "coming back to foreground" and rebuilds SR.
  ── */
  useEffect(() => {
    if (!IS_MOBILE) return;

    function onVisible() {
      if (document.hidden) return;
      if (!isListeningRef.current) return;
      if (recActiveRef.current) return;

      clearTimeout(restartTimerRef.current);
      sessionRef.current++;
      processedFinalCountRef.current = 0; // new SR instance = fresh counter
      const ok = buildRecognitionRef.current?.();
      if (ok) {
        restartTimerRef.current = setTimeout(() => {
          if (isListeningRef.current) safeStartRef.current?.();
        }, 700);
      }
    }

    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Controls ── */
  async function startListening() {
    sessionRef.current++;
    processedFinalCountRef.current = 0; // reset duplicate guard for new session

    setFinalText("");
    setInterimText("");
    setConversationLog([]); // clear log for fresh session
    bufferFinalRef.current  = "";
    lastSentHashRef.current = "";
    pendingTextRef.current  = "";
    historyRef.current      = [];
    clearFlushTimers();
    setStatus("listening");
    setIsListening(true);
    isListeningRef.current = true;
    resetAutoStop();

    const ok = buildRecognition();
    if (!ok) return;

    stopVAD();
    await startVAD(); // no-op on mobile
    safeStart();
  }

  function stopListening() {
    sessionRef.current++;

    isListeningRef.current = false;
    recActiveRef.current   = false;
    setIsListening(false);
    setStatus("idle");
    clearFlushTimers();
    clearTimeout(autoStopTimerRef.current);
    clearTimeout(restartTimerRef.current);

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

  function handleLiveToggle(val) {
    setShowLive(val);
    setTranscriptOpen(val);
  }

  /* ── Keep stable refs current every render ── */
  startListeningRef.current   = startListening;
  stopListeningRef.current    = stopListening;
  buildRecognitionRef.current = buildRecognition;
  safeStartRef.current        = safeStart;

  /* ── Space key shortcut (desktop) ── */
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
            ⚡ Proactive
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
              onChange={(e) => handleLiveToggle(e.target.checked)}
            />
            <span className="toggleTrack" />
            <span className="toggleLabel">Live transcript</span>
          </label>
        </div>
      </div>

      {/* ── Status bar + Start/Stop ── */}
      <div className="statusRow">
        <StatusBar status={status} wsStatus={wsStatus} mode={mode} />
        {unsupported ? (
          <span className="unsupportedNote">⚠️ Use Chrome (Android) or Safari (iOS)</span>
        ) : (
          <button
            className={`actionBtn${isListening ? " actionBtnStop" : " actionBtnStart"}`}
            onClick={isListening ? stopListening : startListening}
          >
            {isListening ? "Stop" : "Start"}
          </button>
        )}
      </div>

      {/* ── Conversation Log ── */}
      <div className="card">
        <ConversationLog
          log={conversationLog}
          status={status}
          isListening={isListening}
          mode={mode}
        />
      </div>

      {/* ── Live transcript ── */}
      <TranscriptPanel
        transcript={finalText}
        interimText={showLive ? interimText : ""}
        isOpen={transcriptOpen}
        animated={transcriptAnimated}
        onToggle={() => setTranscriptOpen((o) => !o)}
        onClear={clearTranscript}
        mode={mode}
      />

      {/* ── Context / System Prompt ── */}
      <div className="card">
        <ChatBox systemPrompt={systemPrompt} setSystemPrompt={setSystemPrompt} />
      </div>

    </div>
  );
}
