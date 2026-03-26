export default function StatusBar({ status, wsStatus, mode }) {
  return (
    <div style={{ opacity: 0.9, fontSize: 13, color: "rgba(229,231,235,0.85)" }}>
      Status: <b>{status}</b> &nbsp;|&nbsp; WS: <b>{wsStatus}</b> &nbsp;|&nbsp; Mode: <b>{mode}</b>
    </div>
  );
}
