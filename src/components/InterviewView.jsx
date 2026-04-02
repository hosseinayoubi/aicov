import { useEffect, useRef, useState } from "react";
import "./InterviewView.css";

export default function InterviewView({
  conversationLog,
  finalText,
  interimText,
  isListening,
  speaker,
  onSpeakerToggle,
  onEditSetup,
}) {
  const teleprompterRef = useRef(null);
  const scrollAnimRef   = useRef(null);
  const [isScrolling, setIsScrolling] = useState(false);
  const [scrollSpeed,  setScrollSpeed]  = useState(35); // px/s

  const latestEntry = conversationLog[conversationLog.length - 1];
  const pastEntries = conversationLog.slice(0, -1);

  // Auto-start teleprompter when suggestion is ready and speaker = me
  useEffect(() => {
    if (speaker === "me" && latestEntry?.answer && !latestEntry.streaming) {
      if (teleprompterRef.current) teleprompterRef.current.scrollTop = 0;
      setIsScrolling(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestEntry?.id, latestEntry?.streaming, speaker]);

  // Pause scrolling when switching back to interviewer
  useEffect(() => {
    if (speaker !== "me") setIsScrolling(false);
  }, [speaker]);

  // Smooth scroll loop
  useEffect(() => {
    cancelAnimationFrame(scrollAnimRef.current);
    if (!isScrolling || !teleprompterRef.current) return;

    const el = teleprompterRef.current;
    let last = null;

    function frame(ts) {
      if (!last) last = ts;
      const dt = (ts - last) / 1000;
      last = ts;
      el.scrollTop += scrollSpeed * dt;
      if (el.scrollTop >= el.scrollHeight - el.clientHeight - 2) {
        setIsScrolling(false);
        return;
      }
      scrollAnimRef.current = requestAnimationFrame(frame);
    }

    scrollAnimRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(scrollAnimRef.current);
  }, [isScrolling, scrollSpeed]);

  function togglePlay() {
    if (!isScrolling && teleprompterRef.current) {
      teleprompterRef.current.scrollTop = 0;
    }
    setIsScrolling(s => !s);
  }

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
              {latestEntry.streaming ? "⏳ Generating answer…" : "💡 Suggested Answer"}
            </span>
            {!latestEntry.streaming && latestEntry.answer && (
              <div className="tpControls">
                <button
                  className="tpBtn"
                  title="Slower"
                  onClick={() => setScrollSpeed(s => Math.max(8, s - 10))}
                >🐢</button>
                <button
                  className={`tpBtn tpPlay${isScrolling ? " tpPlaying" : ""}`}
                  title={isScrolling ? "Pause" : "Auto-scroll"}
                  onClick={togglePlay}
                >
                  {isScrolling ? "⏸" : "▶"}
                </button>
                <button
                  className="tpBtn"
                  title="Faster"
                  onClick={() => setScrollSpeed(s => s + 10)}
                >🐇</button>
              </div>
            )}
          </div>

          <div className="tpBody" ref={teleprompterRef}>
            {latestEntry.answer ? (
              latestEntry.answer
            ) : (
              <span className="tpDots">
                <span className="dot">.</span>
                <span className="dot">.</span>
                <span className="dot">.</span>
              </span>
            )}
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
