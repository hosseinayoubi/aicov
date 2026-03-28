import "./TranscriptPanel.css";

export default function TranscriptPanel({
  transcript,
  interimText,
  isOpen,
  animated,
  onToggle,
  onClear,
  mode,
}) {
  const wordCount = transcript
    ? transcript.trim().split(/\s+/).filter(Boolean).length
    : 0;

  return (
    <div className="card transcriptCard">

      {/* ── Clickable header ── */}
      <div
        className="transcriptHeader"
        onClick={onToggle}
        role="button"
        aria-expanded={isOpen}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onToggle();
        }}
      >
        <div className="transcriptHeaderLeft">
          <span className="cardTitle" style={{ marginBottom: 0 }}>
            Live transcript
          </span>
          {wordCount > 0 && (
            <span className="transcriptBadge">{wordCount}w</span>
          )}
        </div>

        <div className="transcriptHeaderRight">
          {transcript && (
            <button
              className="clearBtn"
              onClick={(e) => { e.stopPropagation(); onClear(); }}
              title="Clear transcript"
              tabIndex={-1}
            >
              ✕
            </button>
          )}
          <span className={`transcriptChevron${isOpen ? " open" : ""}`}>▾</span>
        </div>
      </div>

      {/* ── Animated drawer ──
           The `animated` prop is false on the very first render (before the
           first rAF in App.jsx fires). This prevents the CSS height
           transition from running during initial paint, which caused a
           visible layout jump at page load. After the first frame,
           `animated` becomes true and all subsequent open/close actions
           animate normally. ── */}
      <div className={[
        "transcriptDrawer",
        isOpen     ? "drawerOpen" : "",
        animated   ? "drawerAnimated" : "",
      ].filter(Boolean).join(" ")}>
        <div className="transcriptDrawerInner">
          <div className="transcriptBox">
            {transcript ? (
              <>
                <span className="finalText">{transcript}</span>
                {interimText && (
                  <span className="interimText"> {interimText}</span>
                )}
              </>
            ) : (
              <span className="placeholder">Say something…</span>
            )}
          </div>
          <div className="hint">
            Sends after 380 ms silence · Fast-flush at 6+ words ·{" "}
            Gate: {mode === "proactive" ? "1.4 s" : "0.8 s"}
          </div>
        </div>
      </div>

    </div>
  );
}
