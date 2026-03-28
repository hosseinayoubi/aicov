export default function SuggestionPanel({ text, isListening, status }) {
  if (text) {
    return <div className="suggestionText">{text}</div>;
  }

  if (status === "idle" && !isListening) {
    return <div className="suggestionIdle">Press Start to begin…</div>;
  }

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
