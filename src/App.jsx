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

/* ── Platform ─────────────────────────────────────────────────────────── */
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(
  typeof navigator !== "undefined" ? navigator.userAgent : ""
);

/* ── Tuning ───────────────────────────────────────────────────────────── */
// Prioritise accuracy over speed.
// Mobile SR finalises words slower and is less reliable — give it much more room.
const SILENCE_MS       = IS_MOBILE ? 1400 : 700;
const FAST_FLUSH_WORDS = IS_MOBILE ? 14   : 9;
const GATE_MS = IS_MOBILE
  ? { proactive: 5000, deep: 4000 }
  : { proactive: 2500, deep: 1500 };

const AUTO_STOP_MS        = 2 * 60 * 1000;
const RESTART_DEBOUNCE_MS = IS_MOBILE ? 700 : 120;
const MAX_HISTORY_TURNS   = 3;
const MAX_LOG_ENTRIES     = 8;

// VAD — desktop only (see startVAD)
const VAD_INTERVAL_MS = 50;
const VAD_THRESHOLD   = 0.012;
const VAD_SILENCE_MS  = 900;

/* ─────────────────────────────────────────────────────────────────────── */

export default function App() {
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
  const [conversationLog,    setConversationLog]    = useState([]);

  /* ── Refs ── */
  const isListeningRef  = useRef(false);
  const modeRef         = useRef("proactive");
  const systemPromptRef = useRef("You are a proactive AI copilot.");
  const showLiveRef     = useRef(true);

  const recognitionRef = useRef(null);
  const recActiveRef   = useRef(false);
  const sessionRef     = useRef(0);

  // ── Cumulative-finals tracker ──────────────────────────────────────────
  // Chrome (especially mobile) fires isFinal multiple times for overlapping
  // portions of the same utterance, and can re-deliver all previous finals
  // with resultIndex=0 after an internal restart.
  //
  // Fix: for each SR instance, we rebuild the COMPLETE finals text from
  // e.results[0..N] every time. We keep committedTextRef as the portion
  // already added to the buffer. Only the NEW suffix is processed.
  // Reset on every buildRecognition call (new SR instance = clean slate).
  const committedTextRef = useRef("");

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

  // Stable fn refs for effects and visibilitychange handler
  const startListeningRef   = useRef(null);
  const stopListeningRef    = useRef(null);
  const buildRecognitionRef = useRef(null);
  const safeStartRef        = useRef(null);

  /* ── Sync refs ── */
  useEffect(() => { isListeningRef.current  = isListening;  }, [isListening]);
  useEffect(() => { modeRef.current         = mode;         }, [mode]);
  useEffect(() => { systemPromptRef.current = systemPrompt; }, [systemPrompt]);
  useEffect(() => { showLiveRef.current     = showLive;     }, [showLive]);

  /* ── Drawer animation: only after first paint (prevents initial jump) ── */
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
     Each call appends a new entry to conversationLog. Entries accumulate
     for the whole session — old answers stay visible and readable.
     Text streams in directly (no typewriter delay).
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
    const entryMode  = modeRef.current;

    isReplyingRef.current = true;
    setStatus("thinking");
    setWsStatus("connected");

    // Append new streaming entry (keep last MAX_LOG_ENTRIES)
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
          text  : clean,
          system: systemPromptRef.current,
          mode  : entryMode,
          history,
          requestId,
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        setWsStatus("error");
        setStatus("backend_error");
        setConversationLog(prev => prev.map(e =>
          e.id === requestId
            ? { ...e, streaming: false, answer: e.answer || "⚠ Error" }
            : e
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
        // Update answer in real time
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

      // Mark entry complete
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
      }, GATE_MS[modeRef.current] ?? 2500);
    }
  }

  /* ── VAD (desktop only) ───────────────────────────────────────────────
     On mobile, VAD calls getUserMedia which conflicts with SR's own
     internal getUserMedia — the mic is exclusive so one silently fails.
     Mobile uses timer-only flush (SILENCE_MS / GATE_MS above). ── */
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
          if (silMs >= VAD_SILENCE_MS && !vadFlushedRef.current
              && (bufferFinalRef.current || "").trim()) {
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
     Called on every startListening (and visibilitychange recovery).
     mySession = sessionRef.current at creation — stale events discarded.

     KEY FIX — Cumulative finals deduplication:
     We rebuild allFinals from ALL e.results[0..N] on every onresult call.
     committedTextRef tracks how many characters of that string we've
     already added to the buffer. Only the NEW suffix is processed.

     This eliminates duplicates regardless of how Chrome delivers finals:
     - Repeated isFinal for overlapping text → no-op (nothing new beyond committed)
     - Re-delivery after restart with resultIndex=0 → same, all already committed
     - committedTextRef resets on buildRecognition → correct per-instance tracking
  ── */
  function buildRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setStatus("unsupported"); return false; }

    try { recognitionRef.current?.stop?.(); } catch {}
    recActiveRef.current   = false;
    committedTextRef.current = ""; // RESET for new SR instance

    const rec           = new SR();
    rec.continuous      = true;
    rec.interimResults  = true;
    rec.lang            = "en-US";
    rec.maxAlternatives = 1;

    const mySession = sessionRef.current;

    rec.onstart = () => { recActiveRef.current = true; };

    rec.onresult = (e) => {
      if (sessionRef.current !== mySession) return;

      // ── Build complete finals text for this SR instance ──────────────
      // Loop ALL results (0..length-1), not just from e.resultIndex.
      // This way we always have the complete picture and can diff against
      // what we've already committed.
      let allFinals = "";
      let lastInterim = "";

      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        const t = r?.[0]?.transcript || "";
        if (r.isFinal) {
          allFinals += (allFinals ? " " : "") + t.trim();
        } else {
          // Take only the most recent interim (last non-final result)
          lastInterim = t.trim();
        }
      }

      // ── Only process the truly NEW portion ──────────────────────────
      if (allFinals.length > committedTextRef.current.length) {
        const newChunk = allFinals
          .slice(committedTextRef.current.length)
          .trim();
        committedTextRef.current = allFinals;

        if (newChunk) {
          setFinalText(prev =>
            (prev ? prev + " " + newChunk : newChunk).trim()
          );
          bufferFinalRef.current = (
            bufferFinalRef.current + " " + newChunk
          ).trim();
          vadFlushedRef.current = false;
          scheduleFlush();
          resetAutoStop();
        }
      }

      setInterimText(showLiveRef.current ? lastInterim : "");
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

      // audio-capture: mic busy — some browsers skip onend after this
      if (e.error === "audio-capture") {
        clearTimeout(restartTimerRef.current);
        restartTimerRef.current = setTimeout(() => {
          if (isListeningRef.current && sessionRef.current === mySession) {
            safeStartRef.current?.();
          }
        }, IS_MOBILE ? 1500 : 600);
        return;
      }
      // no-speech, network, aborted → onend fires → normal restart path
    };

    rec.onend = () => {
      recActiveRef.current = false;
      if (!isListeningRef.current) return;
      // Do NOT increment sessionRef — within-session restart, mySession valid
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = setTimeout(() => {
        if (isListeningRef.current && sessionRef.current === mySession) {
          // Reset committedTextRef for the new micro-session that Chrome starts
          committedTextRef.current = "";
          safeStartRef.current?.();
        }
      }, RESTART_DEBOUNCE_MS);
    };

    recognitionRef.current = rec;
    return true;
  }

  /* ── Mount ── */
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

  /* ── Mobile: screen-lock / background recovery ───────────────────────
     When user locks screen or switches apps, SR stops. On some mobile
     browsers start() silently fails while locked. On return, isListening
     is true but recActive is false — nothing works.
     visibilitychange fires on "return to foreground" and rebuilds SR. ── */
  useEffect(() => {
    if (!IS_MOBILE) return;

    function onVisible() {
      if (document.hidden) return;
      if (!isListeningRef.current) return;
      if (recActiveRef.current) return;

      clearTimeout(restartTimerRef.current);
      sessionRef.current++;
      const ok = buildRecognitionRef.current?.();
      if (ok) {
        restartTimerRef.current = setTimeout(() => {
          if (isListeningRef.current) safeStartRef.current?.();
        }, 800);
      }
    }

    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Controls ── */
  async function startListening() {
    sessionRef.current++;
    committedTextRef.current = "";

    setFinalText("");
    setInterimText("");
    setConversationLog([]);
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
    bufferFinalRef.current   = "";
    lastSentHashRef.current  = "";
    committedTextRef.current = "";
  }

  function handleLiveToggle(val) {
    setShowLive(val);
    setTranscriptOpen(val);
  }

  /* ── Keep stable refs current ── */
  startListeningRef.current   = startListening;
  stopListeningRef.current    = stopListening;
  buildRecognitionRef.current = buildRecognition;
  safeStartRef.current        = safeStart;

  /* ── Space shortcut (desktop) ── */
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
          >⚡ Proactive</button>
          <button
            className={`chip${mode === "deep" ? " active" : ""}`}
            onClick={() => setMode("deep")}
          >🎧 Deep</button>
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

      {/* ── Status row ── */}
      <div className="statusRow">
        <StatusBar status={status} wsStatus={wsStatus} mode={mode} />
        {unsupported ? (
          <span className="unsupportedNote">⚠️ Chrome (Android) or Safari (iOS)</span>
        ) : (
          <button
            className={`actionBtn${isListening ? " actionBtnStop" : " actionBtnStart"}`}
            onClick={isListening ? stopListening : startListening}
          >
            {isListening ? "Stop" : "Start"}
          </button>
        )}
      </div>

      {/* ── Conversation log ── */}
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
