import { useSession } from "./useSession";
import { ChatPanel } from "./components/ChatPanel";
import { TracePanel } from "./components/TracePanel";
import { Ticker } from "./components/Ticker";

export function App() {
  const session = useSession();
  const { state, connection, isMock } = session;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-name">DEEP ANALYST</span>
          <span className="microlabel">AGENT OPS CONSOLE</span>
        </div>
        <Ticker state={state} />
        <div className="topbar-status">
          {isMock && <span className="tag tag-replay">REPLAY</span>}
          {state.model && <span className="microlabel">{state.model}</span>}
          <span className={`conn conn-${connection}`}>
            <span className="conn-dot" />
            {connection === "live" ? "LIVE" : connection === "connecting" ? "CONNECTING" : "RECONNECTING"}
          </span>
        </div>
      </header>
      <main className="panes">
        <ChatPanel session={session} />
        <TracePanel session={session} />
      </main>
    </div>
  );
}
