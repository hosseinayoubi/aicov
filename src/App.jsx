import { useEffect, useRef, useState } from "react";
import StatusBar from "./components/StatusBar.jsx";
import SuggestionPanel from "./components/SuggestionPanel.jsx";
import ChatBox from "./components/ChatBox.jsx";
import TranscriptPanel from "./components/TranscriptPanel.jsx";

/* ── Helpers ── */
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

/* ── Constants ── */
const AUTO_STOP_MS        = 2 * 60 * 1000;
const RESTART_DEBOUNCE_MS = 100;
const WORD_FLUSH_THRESH   = 8;
const LONG_GATE_PROACTIVE = 3_000;
const LONG_GATE_DEEP      = 1_500;
const MAX_HISTORY_TURNS   = 3;

// VAD
const VAD_INTERVAL_MS = 50;
const VAD_THRESHOLD   = 0.012;
const VAD_SILENCE_MS  = 550;

/* ────────────────────────────────────────────────────────────────────── */

export default function App() {
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

  /* ── Refs ── */
  const isListeningRef   = useRef(false);
  const modeRef          = useRef("proactive");
  const systemPromptRef  = useRef("You are a proactive AI copilot.");
  const showLiveRef      = useRef(true);

  const recognitionRef   = useRef(null);
  const recActiveRef     = useRef(false);
  const bufferFinalRef   = useRef("");
  const lastSentHashRef  = useRef("");
  const longGateTimerRef = useRef(null);
  const typeTimerRef     = useRef(null);
  const lastRequestIdRef = useRef("");
  const abortRef         = useRef(null);
  const autoStopTimerRef = useRef(null);
  const restartTimerRef  = useRef(null);

  // VAD
  const audioCtxRef       = useRef(null);
  const analyserRef       = useRef(null);
  const micStreamRef      = useRef(null);
  const vadLoopRef        = useRef(null);
  const lastSpeechTimeRef = useRef(0);
  const vadFlushedRef     = useRef(false);

  // Conversation history (in-memory, resets each session)
  const historyRef = useRef([]);

  // Queue: speech heard while replying waits here instead of aborting the reply
  const pendingTextRef = useRef("");
  const isReplyingRef  = useRef(false);

  // Stable refs for Space shortcut
  const startListeningRef = useRef(null);
  const stopListeningRef  = useRef(null);

  /* ── Sync refs with state ── */
  useEffect(() => { isListeningRef.current  = isListening;  }, [isListening]);
  useEffect(() => { modeRef.current         = mode;         }, [mode]);
  useEffect(() => { systemPromptRef.current = systemPrompt; }, [systemPrompt]);
  useEffect(() => { showLiveRef.current     = showLive;     }, [showLive]);

  /* ── Timer helpers ── */
  function clearAdaptiveTimers() {
    clearTimeout(longGateTimerRef.current);
    longGateTimerRef.current = null;
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

    // ── FIX 2: hash deduplication ──────────────────────────────────────────
    // hash فقط برای جلوگیری از دوبار ارسال همزمان چک می‌شه.
    // بعد از هر reply موفق ریست می‌شه (پایین‌تر)، بنابراین
    // کاربر می‌تونه همون جمله رو بعداً دوباره بپرسه.
    // ─────────────────────────────────────────────────────────────────────
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
        // cleanup را به finally واگذار می‌کنیم — اینجا return کافیه
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
        // اگه این request دیگه active نیست، بی‌سروصدا خارج شو
        if (lastRequestIdRef.current !== requestId) return;
        acc += chunk;
        setLiveReply(acc);
      }

      // یه چک آخر قبل از commit کردن نتیجه
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

      // ── FIX 2: بعد از هر reply موفق hash رو reset کن ──────────────────
      // این اجازه می‌ده کاربر همون جمله رو دوباره بپرسه و جواب بگیره.
      lastSentHashRef.current = "";
      // ─────────────────────────────────────────────────────────────────

      setStatus(isListeningRef.current ? "listening" : "idle");

    } catch (e) {
      if (e?.name === "AbortError") return;
      console.error("Fetch failed:", e);
      setWsStatus("error");
      setStatus("backend_error");

    } finally {
      // ── FIX 1: Race Condition Guard ────────────────────────────────────
      // finally همیشه اجرا می‌شه — حتی برای requestهای ابورت‌شده.
      // بدون این guard، request قدیمی می‌تونه isReplyingRef و pendingTextRef
      // request جدید رو خراب کنه و جواب هرگز نرسه.
      //
      // فقط اگه این request هنوز «active» هست cleanup انجام بده.
      // ─────────────────────────────────────────────────────────────────
      if (lastRequestIdRef.current === requestId) {
        isReplyingRef.current = false;

        // اگه در حین reply حرف جدیدی شنیده شده، الان پردازش کن
        const pending = pendingTextRef.current.trim();
        pendingTextRef.current = "";
        if (pending) {
          sendToBackend(pending);
        }
      }
    }
  }

  /* ── Flush buffer ── */
  function flushBuffer() {
    const t = (bufferFinalRef.current || "").trim();
    if (!t) return;
    bufferFinalRef.current = "";
    vadFlushedRef.current  = true;
    clearAdaptiveTimers();

    if (isReplyingRef.current) {
      // Reply هنوز داره stream می‌شه — به‌جای abort کردن، queue کن
      pendingTextRef.current = (pendingTextRef.current + " " + t).trim();
      return;
    }

    sendToBackend(t);
  }

  /* ── Gate fallback (safety net when VAD is unavailable) ── */
  function scheduleGateFallback() {
    clearAdaptiveTimers();
    if (!(bufferFinalRef.current || "").trim()) return;

    const words = bufferFinalRef.current.trim().split(/\s+/).length;
    if (words >= WORD_FLUSH_THRESH) { flushBuffer(); return; }

    const gateMs = modeRef.current === "proactive"
      ? LONG_GATE_PROACTIVE
      : LONG_GATE_DEEP;
    longGateTimerRef.current = setTimeout(flushBuffer, gateMs);
  }

  /* ── VAD (Web Audio API) ── */
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

  /* ── Safe recognition start ── */
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

    rec.onstart = () => { recActiveRef.current = true; };

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
        vadFlushedRef.current = false;
        scheduleGateFallback();
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

      if (e.error === "audio-capture") {
        console.warn("Audio capture conflict — will retry via onend");
      }
    };

    rec.onend = () => {
      recActiveRef.current = false;
      if (!isListeningRef.current) return;
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
      stopVAD();
      if (abortRef.current) abortRef.current.abort();
      clearAdaptiveTimers();
      clearInterval(typeTimerRef.current);
      clearTimeout(autoStopTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Controls ── */
  async function startListening() {
    if (!recognitionRef.current) return;
    setFinalText("");
    setInterimText("");
    bufferFinalRef.current  = "";
    lastSentHashRef.current = "";
    pendingTextRef.current  = "";
    historyRef.current      = [];
    clearAdaptiveTimers();
    setReply("");
    setLiveReply("");
    setStatus("listening");
    setIsListening(true);
    isListeningRef.current = true;
    resetAutoStop();

    // ── FIX 3: قبل از شروع VAD جدید، VAD قدیمی رو کامل متوقف کن ────────
    // بدون این، اگه startListening دوباره صدا زده بشه، ممکنه کوتاه‌مدت
    // دو تا VAD interval موازی داشته باشیم که race condition ایجاد می‌کنه.
    stopVAD();
    // ─────────────────────────────────────────────────────────────────────

    await startVAD();
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

  /* ── Space shortcut ── */
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
                if (!val) setTranscriptOpen(false);
                else setTranscriptOpen(true);
              }}
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

      {/* ── Live transcript — collapsible drawer ── */}
      <TranscriptPanel
        transcript={finalText}
        interimText={showLive ? interimText : ""}
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
          <span>Space to toggle · Auto-stop: 2 min</span>
        </div>
      </div>

    </div>
  );
}
