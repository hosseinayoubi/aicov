export default function SuggestionPanel({ text }) {
  return (
    <div style={{ fontSize: "1.05rem", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
      {text || "Listening..."}
    </div>
  );
}
