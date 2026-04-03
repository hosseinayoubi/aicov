import "./InterviewView.css";

export default function InterviewSetup({ cv, setCV, jd, setJD, onStart }) {
  const cvWords = cv.trim().split(/\s+/).filter(Boolean).length;
  const jdWords = jd.trim().split(/\s+/).filter(Boolean).length;
  const canStart = cvWords >= 30 && jdWords >= 30;

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
            rows={10}
            placeholder={
              "Paste your full CV here — no limit.\n\n" +
              "Include work history, achievements,\n" +
              "technical skills, education, and projects."
            }
          />
          <div className="setupHint">{cvWords.toLocaleString()} words</div>
        </div>

        <div className="setupField">
          <label className="setupLabel">💼 Job Description</label>
          <textarea
            className="setupTextarea"
            value={jd}
            onChange={e => setJD(e.target.value)}
            rows={10}
            placeholder={
              "Paste the full job description here — no limit.\n\n" +
              "Include role title, responsibilities,\n" +
              "required skills, and company info."
            }
          />
          <div className="setupHint">{jdWords.toLocaleString()} words</div>
        </div>
      </div>

      <button
        className={`startInterviewBtn${canStart ? " ready" : ""}`}
        onClick={onStart}
        disabled={!canStart}
      >
        {canStart
          ? "🚀 Start Interview"
          : `Add a bit more to get started — CV: ${cvWords}/30 · JD: ${jdWords}/30`}
      </button>
    </div>
  );
}
