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

  const label =
    status === "thinking" ? "Thinking" :
    status === "replying" ? "Replying" : "Listening";

  return (
    <div className="listeningState">
      {label}
      <span className="dot">.</span>
      <span className="dot">.</span>
      <span className="dot">.</span>
    </div>
  );
}
