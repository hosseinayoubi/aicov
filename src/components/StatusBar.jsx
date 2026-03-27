const STATUS_MAP = {
  idle          : { dot: "gray",   label: "idle"        },
  listening     : { dot: "green",  label: "listening"   },
  thinking      : { dot: "yellow", label: "thinking"    },
  replying      : { dot: "blue",   label: "replying"    },
  backend_error : { dot: "red",    label: "error"       },
  unsupported   : { dot: "red",    label: "unsupported" },
};

export default function StatusBar({ status, wsStatus, mode }) {
  const cfg    = STATUS_MAP[status] ?? { dot: "gray", label: status };
  const wsDot  = wsStatus === "connected" ? "green" : "red";

  return (
    <div className="statusBar">
      <span className={`statusDot ${cfg.dot}`} />
      <span>Status: <b>{cfg.label}</b></span>
      <span className="statusSep">|</span>
      <span className={`statusDot ${wsDot}`} />
      <span>WS: <b>{wsStatus}</b></span>
      <span className="statusSep">|</span>
      <span>Mode: <b>{mode}</b></span>
    </div>
  );
}
