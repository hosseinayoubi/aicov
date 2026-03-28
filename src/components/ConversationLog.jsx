import { useEffect, useRef } from "react";

/* ── ConversationLog ────────────────────────────────────────────────────
   Replaces the old SuggestionPanel.
   Renders a persistent conversation history for the current session:
   - Each sendToBackend call creates one entry {id, question, answer, streaming, mode}
   - Entries ACCUMULATE — old answers don't disappear
   - Current streaming entry is visually distinct (blue border, pulsing dot)
   - Previous entries are dimmed but fully readable
   - Text streams in directly (no typewriter) so the user reads ASAP
   - Proactive and Deep entries look different to make context clear
─────────────────────────────────────────────────────────────────────── */
export default function ConversationLog({ log, status, isListening, mode }) {
  const bottomRef = useRef(null);

  // Scroll to the latest entry whenever log changes
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [log]);

  /* Empty state */
  if (log.length === 0) {
    if (!isListening && status === "idle") {
      return (
        <div className="logEmpty">
          Press <b>Start</b> to begin listening…
        </div>
      );
    }
    if (isListening && status === "listening") {
      return (
        <div className="logEmpty logListening">
          <span className="logListeningDot" />
          Listening — waiting for speech…
        </div>
      );
    }
    if (status === "thinking") {
      return (
        <div className="logEmpty">
          <span className="dot">.</span>
          <span className="dot">.</span>
          <span className="dot">.</span>
        </div>
      );
    }
    return <div className="logEmpty">—</div>;
  }

  return (
    <div className="logList">
      {log.map((entry, idx) => {
        const isActive = entry.streaming;
        const isLatest = idx === log.length - 1;
        const isPast   = !isLatest;
        const label    = entry.mode === "deep" ? "Answer" : "Suggestion";

        return (
          <div
            key={entry.id}
            className={[
              "logEntry",
              isActive ? "logEntryActive" : "",
              isPast   ? "logEntryPast"   : "",
              entry.mode === "deep" ? "logEntryDeep" : "logEntryProactive",
            ].filter(Boolean).join(" ")}
          >
            {/* ── Entry header: mode label + streaming indicator ── */}
            <div className="logEntryHeader">
              <span className="logLabel">{label}</span>
              {isActive && <span className="logStreamDot" />}
            </div>

            {/* ── Answer text ── */}
            {entry.answer ? (
              <div className="logAnswer">{entry.answer}</div>
            ) : (
              <div className="logThinking">
                <span className="dot">.</span>
                <span className="dot">.</span>
                <span className="dot">.</span>
              </div>
            )}

            {/* ── Question / trigger snippet ──
                Proactive: shows the conversation fragment that triggered the suggestion.
                Deep: shows what the user asked directly.
                Truncated for space. ── */}
            {entry.question && (
              <div className="logQuestion" title={entry.question}>
                ↪ {entry.question.length > 90
                  ? entry.question.slice(0, 90) + "…"
                  : entry.question}
              </div>
            )}
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
