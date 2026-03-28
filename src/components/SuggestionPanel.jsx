import { useState } from "react";
import "./SuggestionPanel.css";

export default function SuggestionPanel({ text, isListening, status }) {
  const [copied, setCopied] = useState(false);

  function copyText() {
    if (!text) return;
    navigator.clipboard.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }

  // ── Has a suggestion to show ──────────────────────────────────────────
  if (text) {
    return (
      <div className="suggestionWrapper">
        <div className="suggestionText">{text}</div>
        <button
          className={`copyBtn${copied ? " copied" : ""}`}
          onClick={copyText}
          title="Copy to clipboard"
        >
          {copied ? "✓" : "⎘"}
        </button>
      </div>
    );
  }

  // ── Idle — not listening and no suggestion yet ────────────────────────
  if (status === "idle" && !isListening) {
    return (
      <div className="suggestionIdle">
        Press Start to begin…
      </div>
    );
  }

  // ── Active states: listening / thinking / replying ────────────────────
  const label =
    status === "thinking" ? "Thinking" :
    status === "replying" ? "Replying" :
    "Listening";

  return (
    <div className="listeningState">
      {label}
      <span className="dot">.</span>
      <span className="dot">.</span>
      <span className="dot">.</span>
    </div>
  );
}
