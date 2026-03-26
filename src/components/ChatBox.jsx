export default function ChatBox({ systemPrompt, setSystemPrompt }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ marginBottom: 6, opacity: 0.7 }}>Context / Prompt</div>

      <textarea
        value={systemPrompt}
        onChange={(e) => setSystemPrompt(e.target.value)}
        rows={3}
        placeholder="مثلاً: تو یه مصاحبه کاری هستی، جواب‌ها کوتاه و confident باشن"
        style={{
          width: "100%",
          padding: 10,
          background: "#0b1220",
          color: "#e5e7eb",
          border: "1px solid #334155",
          borderRadius: 8,
          outline: "none",
          boxSizing: "border-box",
        }}
      />
    </div>
  );
}
