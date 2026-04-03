import { useCallback, useEffect, useRef, useState } from "react";
import "./InterviewView.css";

const MATCH_WORDS = 6;

export default function InterviewView({
  conversationLog,
  finalText,
  interimText,
  isListening,
  speaker,
  onSpeakerToggle,
  onEditSetup,
  onAnswerRead,
}) {
  const teleprompterRef = useRef(null);
  const scrollAnimRef   = useRef(null);

  const [syncMode,    setSyncMode]    = useState("voice");
  const [isScrolling, setIsScrolling] = useState(false);
  const [scrollSpeed, setScrollSpeed] = useState(35);

  const latestEntry = conversationLog[conversationLog.length - 1];
  const pastEntries = conversationLog.slice(0, -1);
  const hasAnswer   = latestEntry?.answer && !latestEntry.streaming;

  // ── Reset when new answer arrives ────────────────────────────────────
  useEffect(() => {
    if (!latestEntry?.answer || latestEntry.streaming) return;
    const el = teleprompterRef.current;
    if (el) el.scrollTop = 0;
    setIsScrolling(false);
    setSyncMode("voice");
  }, [latestEntry?.id, latestEntry?.streaming]);

  // ── VOICE-SYNC SCROLL ─────────────────────────────────────────────────
  useEffect(() => {
    if (syncMode !== "voice") return;
    if (speaker !== "me")     return;
    if (!finalText)           return;

    const answer = latestEntry?.answer;
    if (!answer) return;

    const el = teleprompterRef.current;
    if (!el) return;

    const answerLower = answer.toLowerCase();
    const spokenWords = finalText.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (spokenWords.length < 2) return;

    let matchIdx = -1;
    for (let n = Math.min(MATCH_WORDS, spokenWords.length); n >= 2; n--) {
      const chunk = spokenWords.slice(-n).join(" ");
      const idx   = answerLower.lastIndexOf(chunk);
      if (idx !== -1) { matchIdx = idx + chunk.length; break; }
    }

    if (matchIdx === -1) return;

    const progress  = Math.min(matchIdx / answer.length, 1);
    const targetTop = progress * (el.scrollHeight - el.clientHeight);

    if (targetTop > el.scrollTop + 2) {
      el.scrollTo({ top: targetTop, behavior: "smooth" });
    }

    if (progress >= 0.95) {
      onAnswerRead?.();
    }
  }, [finalText, speaker, syncMode, latestEntry?.answer, onAnswerRead]);

  // ── MANUAL FIXED-SPEED SCROLL ─────────────────────────────────────────
  useEffect(() => {
    cancelAnimationFrame(scrollAnimRef.current);
    if (syncMode !== "manual" || !isScrolling) return;

    const el = teleprompterRef.current;
    if (!el) return;

    let last = null;
    function frame(ts) {
      if (!last) last = ts;
      const dt = (ts - last) / 1000;
      last = ts;
      el.scrollTop += scrollSpeed * dt;
      if (el.scrollTop >= el.scrollHeight - el.clientHeight - 2) {
        setIsScrolling(false);
        onAnswerRead?.();
        return;
      }
      scrollAnimRef.current = requestAnimationFrame(frame);
    }

    scrollAnimRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(scrollAnimRef.current);
  }, [isScrolling, scrollSpeed, syncMode, onAnswerRead]);

  const toggleManual = useCallback(() => {
    setSyncMode("manual");
    if (!isScrolling && teleprompterRef.current) {
      teleprompterRef.current.scrollTop = 0;
    }
    setIsScrolling(s => !s);
  }, [isScrolling]);

  const switchToVoice = useCallback(() => {
    cancelAnimationFrame(scrollAnimRef.current);
    setIsScrolling(false);
    setSyncMode("voice");
  }, []);

  return (
    <div className="interviewView">

      {/* ── Speaker Toggle ── */}
      <div className="speakerToggleBar">
        <button
          className={`speakerBtn${speaker === "interviewer" ? " speakerActive" : ""}`}
          onClick={() => onSpeakerToggle("interviewer")}
        >
          <span className="speakerIcon">🎙️</span>
          <span>Interviewer</span>
          {speaker === "interviewer" && isListening && (
            <span className="speakerPulse speakerPulseGreen" />
          )}
        </button>

        <span className="speakerHint">Tab</span>

        <button
          className={`speakerBtn speakerBtnMe${speaker === "me" ? " speakerActive speakerMeActive" : ""}`}
          onClick={() => onSpeakerToggle("me")}
        >
          <span className="speakerIcon">🙋</span>
          <span>Me</span>
          {speaker === "me" && isListening && (
            <span className="speakerPulse speakerPulseBlue" />
          )}
        </button>
      </div>

      {/* ── Status hints ── */}
      {speaker === "interviewer" && hasAnswer && (
        <div className="listenHint">
          👂 Listening for next question… press <kbd>Tab</kbd> when you start answering
        </div>
      )}

      {speaker === "me" && hasAnswer && syncMode === "voice" && (
        <div className="voiceSyncHint">
          🎤 Scroll synced to your voice — read aloud and it follows you
        </div>
      )}

      {/* ── Live Transcript ── */}
      {(finalText || interimText) && (
        <div className={`liveCard${speaker === "me" ? " liveMeCard" : ""}`}>
          <div className="liveCardLabel">
            {speaker === "interviewer" ? "📝 Question detected:" : "🗣️ My answer:"}
          </div>
          <div className="liveCardText">
            <span className="liveFinal">{finalText}</span>
            {interimText && <span className="liveInterim"> {interimText}</span>}
          </div>
        </div>
      )}

      {/* ── AI Suggestion Teleprompter ── */}
      {latestEntry && (
        <div className={`suggCard${latestEntry.streaming ? " suggStreaming" : ""}`}>
          <div className="suggHeader">
            <span className="suggTitle">
              {latestEntry.streaming
                ? "⏳ Generating answer…"
                : speaker === "me"
                  ? "🎤 Reading — scroll follows your voice"
                  : "💡 Suggested Answer"}
            </span>

            {hasAnswer && (
              <div className="tpControls">
                <button
                  className={`tpBtn${syncMode === "voice" ? " tpBtnActive" : ""}`}
                  title="Voice sync — scroll follows your reading"
                  onClick={switchToVoice}
                >🎤</button>

                <button
                  className="tpBtn"
                  title="Slower manual scroll"
                  onClick={() => {
                    setSyncMode("manual");
                    setScrollSpeed(s => Math.max(8, s - 10));
                  }}
                >🐢</button>

                <button
                  className={`tpBtn tpPlay${syncMode === "manual" && isScrolling ? " tpPlaying" : ""}`}
                  title={syncMode === "manual" && isScrolling ? "Pause" : "Manual auto-scroll"}
                  onClick={toggleManual}
                >
                  {syncMode === "manual" && isScrolling ? "⏸" : "▶"}
                </button>

                <button
                  className="tpBtn"
                  title="Faster manual scroll"
                  onClick={() => {
                    setSyncMode("manual");
                    setScrollSpeed(s => s + 10);
                  }}
                >🐇</button>
              </div>
            )}
          </div>

          <div className="tpBody" ref={teleprompterRef}>
            {latestEntry.answer
              ? latestEntry.answer
              : (
                <span className="tpDots">
                  <span className="dot">.</span>
                  <span className="dot">.</span>
                  <span className="dot">.</span>
                </span>
              )
            }
          </div>

          {latestEntry.question && (
            <div className="suggFooter">
              ↪ {latestEntry.question.length > 120
                ? latestEntry.question.slice(0, 120) + "…"
                : latestEntry.question}
            </div>
          )}
        </div>
      )}

      {/* ── Past Q&A ── */}
      {pastEntries.length > 0 && (
        <div className="pastBlock">
          <div className="pastBlockTitle">Previous questions</div>
          {[...pastEntries].reverse().map(e => (
            <div key={e.id} className="pastEntry">
              <div className="pastQ">
                Q: {e.question?.length > 110
                  ? e.question.slice(0, 110) + "…"
                  : e.question}
              </div>
              {e.answer && (
                <div className="pastA">
                  {e.answer.length > 180
                    ? e.answer.slice(0, 180) + "…"
                    : e.answer}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <button className="editSetupLink" onClick={onEditSetup}>
        ✏️ Edit CV / JD
      </button>
    </div>
  );
}
