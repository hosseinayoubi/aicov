export default function SuggestionPanel({ text, isListening, status }) {
  if (text) {
    return <div className="suggestionText">{text}</div>;
  }

  const label =
    status === "thinking" ? "Thinking"  :
    status === "replying" ? "Replying"  :
    isListening           ? "Listening" : "Listening";

  return (
    <div className="listeningState">
      {label}
      <span className="dot">.</span>
      <span className="dot">.</span>
      <span className="dot">.</span>
    </div>
  );
}
