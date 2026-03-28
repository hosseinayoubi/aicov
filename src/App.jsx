import { useEffect, useRef, useState } from "react";
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

/* ── Platform detection (module-level, stable) ────────────────────────── */
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(
  typeof navigator !== "undefined" ? navigator.userAgent : ""
);

/* ── Tuning constants ─────────────────────────────────────────────────── */
const SILENCE_MS       = IS_MOBILE ? 600 : 380;  // mobile SR finalises later
const FAST_FLUSH_WORDS = 6;
const GATE_MS          = { proactive: 1400, deep: 800 };

const AUTO_STOP_MS = 2 * 60 * 1000;

// Mobile needs more time — OS must fully release the mic before SR can
// grab it again. 100 ms on desktop is fine; 500 ms on mobile avoids the
// "audio-capture" loop where rapid restarts keep failing.
const RESTART_DEBOUNCE_MS = IS_MOBILE ? 500 : 100;

const MAX_HISTORY_TURNS = 3;

// VAD — desktop only (see startListening for explanation)
const VAD_INTERVAL_MS = 50;
const VAD_THRESHOLD   = 0.012;
const VAD_SILENCE_MS  = 650;

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
  const [reply,              setReply]              = useState("");
  const [liveReply,          setLiveReply]          = useState("");
  const [isListening,        setIsListening]        = useState(false);

  /* ── Refs ── */
  const isListeningRef  = useRef(false);
  const modeRef         = useRef("proactive");
  const systemPromptRef = useRef("You are a proactive AI copilot.");
  const showLiveRef     = useRef(true);

  const recognitionRef = useRef(null);
  const recActiveRef   = useRef(false);

  // Session counter — stale-event guard.
  // Incremented on startListening and stopListening.
  // NOT incremented in onend — same rec, same session, within-session restart.
  const sessionRef = useRef(0);

  const bufferFinalRef   = useRef("");
  const lastSentHashRef  = useRef("");
  const lastRequestIdRef = useRef("");
  const abortRef         = useRef(null);

  const pendingTextRef = useRef("");
  const isReplyingRef  = useRef(false);
  const historyRef     = useRef([]);

  const silenceTimerRef  = useRef(null);
  const gateTimerRef     = useRef(null);
  const typeTimerRef     = useRef(null);
  const autoStopTimerRef = useRef(null);
  const restartTimerRef  = useRef(null);

  // VAD (desktop only)
  const audioCtxRef       = useRef(null);
  const analyserRef       = useRef(null);
  const micStreamRef      = useRef(null);
  const vadLoopRef        = useRef(null);
  const lastSpeechTimeRef = useRef(0);
  const vadFlushedRef     = useRef(false);

  // Stable refs so effects always call the latest version of these functions
  const startListeningRef   = useRef(null);
  const stopListeningRef    = useRef(null);
  const buildRecognitionRef = useRef(null);
  const safeStartRef        = useRef(null);

  /* ── Sync refs with state ── */
  useEffect(() => { isListeningRef.current  = isListening;  }, [isListening]);
  useEffect(() => { modeRef.current         = mode;         }, [mode]);
  useEffect(() => { systemPromptRef.current = systemPrompt; }, [systemPrompt]);
  useEffect(() => { showLiveRef.current     = showLive;     }, [showLive]);

  /* ── Enable drawer transition after first paint ────────────────────────
     Without this, the CSS grid-template-rows transition fires on mount and
     causes a visible layout shift (the drawer "opens" from 0 to full height
     even though it starts open). One rAF is enough to let React finish its
     first paint before we enable the transition class. ── */
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
      }, GATE_MS[modeRef.current] ?? 1400);
    }
  }

  /* ── VAD (desktop only) ───────────────────────────────────────────────
     VAD calls getUserMedia to watch RMS amplitude in real time, which lets
     us flush the speech buffer the moment the user stops talking — much
     faster than a timer alone.

     WHY DESKTOP ONLY:
     On mobile (Android Chrome, iOS Safari), SpeechRecognition also
     internally calls getUserMedia. When VAD already holds a media stream,
     the browser's mic-access layer is busy. On Android Chrome the SR's
     internal getUserMedia fails silently → no audio is ever captured.
     On iOS it throws "audio-capture". The timer-based flush (scheduleFlush)
     is sufficient on mobile; it still sends within GATE_MS.
  ── */
  async function startVAD() {
    if (IS_MOBILE) return; // see explanation above
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
      // If start() threw, schedule a retry on mobile
      if (IS_MOBILE && isListeningRef.current) {
        clearTimeout(restartTimerRef.current);
        restartTimerRef.current = setTimeout(() => {
          if (isListeningRef.current) safeStartRef.current?.();
        }, RESTART_DEBOUNCE_MS);
      }
    }
  }

  /* ── Build fresh SpeechRecognition per session ─────────────────────────
     Called at the start of every listen session (not at mount) so that
     mySession is always == sessionRef.current, preventing the stale-event
     bug where old onresult callbacks fire after a restart. ── */
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

    const mySession = sessionRef.current; // captured fresh per session

    rec.onstart = () => { recActiveRef.current = true; };

    rec.onresult = (e) => {
      // Discard results from superseded sessions
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

      // Permission denied — hard stop, no retry
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setStatus("unsupported");
        setIsListening(false);
        isListeningRef.current = false;
        stopVAD();
        return;
      }

      // audio-capture: mic busy (most common on mobile after a restart).
      // Some browsers DO fire onend after this; some don't. Schedule an
      // explicit retry so we never get stuck if onend doesn't arrive.
      if (e.error === "audio-capture") {
        clearTimeout(restartTimerRef.current);
        restartTimerRef.current = setTimeout(() => {
          if (isListeningRef.current && sessionRef.current === mySession) {
            safeStartRef.current?.();
          }
        }, IS_MOBILE ? 1000 : 400);
        return;
      }

      // All other errors (no-speech, network, aborted):
      // onend will fire and the normal restart path handles it.
    };

    rec.onend = () => {
      recActiveRef.current = false;
      if (!isListeningRef.current) return;
      // Do NOT increment sessionRef — this is a within-session restart.
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
      clearInterval(typeTimerRef.current);
      clearTimeout(autoStopTimerRef.current);
      try { recognitionRef.current?.stop?.(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Mobile: handle screen lock / app background ────────────────────────
     When the user locks their phone or switches apps, SpeechRecognition
     stops (onend fires) and the normal restart runs. BUT on some mobile
     browsers start() silently fails while the screen is locked, so when
     the user returns, recActiveRef is still false even though
     isListeningRef is true.

     visibilitychange catches the "coming back to foreground" moment and
     rebuilds the recognition from scratch to guarantee a clean state.
  ── */
  useEffect(() => {
    if (!IS_MOBILE) return;

    function onVisible() {
      if (document.hidden) return;              // fired on hide, not show
      if (!isListeningRef.current) return;       // user already stopped
      if (recActiveRef.current) return;          // SR is fine, nothing to do

      // Screen was unlocked / app returned to foreground.
      // Rebuild recognition (new session) then start.
      clearTimeout(restartTimerRef.current);
      sessionRef.current++;
      const ok = buildRecognitionRef.current?.();
      if (ok) {
        restartTimerRef.current = setTimeout(() => {
          if (isListeningRef.current) safeStartRef.current?.();
        }, 600);
      }
    }

    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Controls ── */
  async function startListening() {
    sessionRef.current++;

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

    const ok = buildRecognition();
    if (!ok) return;

    // Desktop only: VAD for real-time amplitude-based silence detection.
    // On mobile this is skipped — see startVAD() for detailed explanation.
    stopVAD();
    await startVAD();

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
    setTranscriptOpen(val); // keep drawer in sync; safe because transcriptAnimated=true here
  }

  /* ── Keep stable refs up to date every render ── */
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
          <span className="unsupportedNote">⚠️ Use Chrome on Android or Safari on iOS</span>
        ) : (
          <button
            className={`actionBtn${isListening ? " actionBtnStop" : " actionBtnStart"}`}
            onClick={isListening ? stopListening : startListening}
          >
            {isListening ? "Stop" : "Start"}
          </button>
        )}
      </div>

      {/* ── Suggestion ── */}
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
