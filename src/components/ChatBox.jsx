export default function ChatBox({ systemPrompt, setSystemPrompt }) {
  return (
    <>
      <div className="promptLabel">Context / Prompt</div>
      <textarea
        className="promptTextarea"
        value={systemPrompt}
        onChange={(e) => setSystemPrompt(e.target.value)}
        rows={3}
        placeholder="e.g. You are in a job interview. Keep answers short and confident."
      />
    </>
  );
}
