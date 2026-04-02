import "./InterviewView.css";

export default function InterviewSetup({ cv, setCV, jd, setJD, onStart }) {
  const cvWords = cv.trim().split(/\s+/).filter(Boolean).length;
  const jdWords = jd.trim().split(/\s+/).filter(Boolean).length;
  const canStart = cvWords >= 20 && jdWords >= 20;

  return (
    <div className="interviewSetup">
      <div className="setupTitle">🎯 Interview Setup</div>
      <p className="setupDesc">
        Paste your CV and the job description. The AI will generate
        targeted answer suggestions in real-time as the interviewer asks questions.
      </p>

      <div className="setupFields">
        <div className="setupField">
          <label className="setupLabel">📄 Your CV / Resume</label>
          <textarea
            className="setupTextarea"
            value={cv}
            onChange={e => setCV(e.target.value)}
            rows={8}
            placeholder={"Paste your CV or key experience here…\n\nE.g. 5 years React dev, led team of 4,\nbuilt XYZ at ABC Corp, increased performance by 40%…"}
          />
          <div className="setupHint">{cvWords} words</div>
        </div>

        <div className="setupField">
          <label className="setupLabel">💼 Job Description</label>
          <textarea
            className="setupTextarea"
            value={jd}
            onChange={e => setJD(e.target.value)}
            rows={8}
            placeholder={"Paste the job description here…\n\nE.g. We're looking for a Senior React\nDeveloper with 3+ years of experience…"}
          />
          <div className="setupHint">{jdWords} words</div>
        </div>
      </div>

      <button
        className={`startInterviewBtn${canStart ? " ready" : ""}`}
        onClick={onStart}
        disabled={!canStart}
      >
        {canStart
          ? "🚀 Start Interview"
          : `Add at least 20 words to each field (CV: ${cvWords}, JD: ${jdWords})`}
      </button>
    </div>
  );
}
