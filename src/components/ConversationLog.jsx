import { useEffect, useRef } from "react";

export default function ConversationLog({ log, status, isListening, mode }) {
  const bottomRef = useRef(null);

  // Scroll to newest entry whenever log updates
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [log]);

  /* ── Empty state ── */
  if (log.length === 0) {
    if (!isListening && status === "idle") {
      return (
        <div className="logEmpty">
          Press <b>Start</b> to begin…
        </div>
      );
    }
    if (status === "listening") {
      return (
        <div className="logEmpty logListening">
          <span className="logListeningDot" />
          Listening…
        </div>
      );
    }
    return (
      <div className="logEmpty">
        <span className="dot">.</span>
        <span className="dot">.</span>
        <span className="dot">.</span>
      </div>
    );
  }

  return (
    <div className="logList">
      {log.map((entry, idx) => {
        const isLatest = idx === log.length - 1;
        const isPast   = !isLatest;
        const label    = entry.mode === "deep" ? "Answer" : "Suggestion";
        const isDeep   = entry.mode === "deep";

        return (
          <div
            key={entry.id}
            className={[
              "logEntry",
              entry.streaming ? "logEntryActive" : "",
              isPast           ? "logEntryPast"   : "",
              isDeep           ? "logEntryDeep"   : "logEntryProactive",
            ].filter(Boolean).join(" ")}
          >
            {/* Header: mode label + streaming dot */}
            <div className="logEntryHeader">
              <span className="logLabel">{label}</span>
              {entry.streaming && <span className="logStreamDot" />}
            </div>

            {/* Answer */}
            {entry.answer ? (
              <div className="logAnswer">{entry.answer}</div>
            ) : (
              <div className="logThinking">
                <span className="dot">.</span>
                <span className="dot">.</span>
                <span className="dot">.</span>
              </div>
            )}

            {/* Trigger snippet */}
            {entry.question && (
              <div className="logQuestion" title={entry.question}>
                ↪ {entry.question.length > 100
                  ? entry.question.slice(0, 100) + "…"
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
