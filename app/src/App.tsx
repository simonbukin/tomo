import { PanelLeft, PanelRight } from "lucide-react";
import { useEffect } from "react";
import { onConnection, onFrame, rpc, startEventPump } from "./api";
import { runAction } from "./actions";
import { ContextMenu } from "./ContextMenu";
import { Dialogs } from "./Dialogs";
import { Towns } from "./Towns";
import { Home } from "./Home";
import { findAction } from "./keys";
import { TabLayout } from "./Layout";
import { Palette } from "./Palette";
import { RightSidebar } from "./RightSidebar";
import { Sidebar } from "./Sidebar";
import { activeTab, applyFrame, applySnapshot, getState, setState, setUi, unviewedAttention, useStore } from "./store";
import { TabBar } from "./Tabs";
import { focusTerminal } from "./terminals";
import type { Snapshot } from "./types";

export function App() {
  const connected = useStore((s) => s.connected);
  const loaded = useStore((s) => s.loaded);
  const ui = useStore((s) => s.ui);
  const worktree = useStore((s) => s.worktrees.find((w) => w.id === s.ui.activeWorktreeId) ?? null);
  const tab = useStore((s) => activeTab(s, s.ui.view === "worktree" ? s.ui.activeWorktreeId : null));
  const focusRequest = useStore((s) => s.focusRequest);
  const notice = useStore((s) => s.notice);
  const attention = useStore((s) => unviewedAttention(s).length);
  const config = useStore((s) => s.config);

  useEffect(() => {
    const offFrame = onFrame(applyFrame);
    const offConn = onConnection((up) => {
      setState((s) => ({ connected: up, connectionNonce: up ? s.connectionNonce + 1 : s.connectionNonce }));
      if (up) rpc<Snapshot>("subscribe").then(applySnapshot).catch(() => {});
    });
    startEventPump();
    return () => {
      offFrame();
      offConn();
    };
  }, []);

  useEffect(() => {
    if (!focusRequest) return;
    const t = window.setTimeout(() => focusTerminal(focusRequest.pane_id), 60);
    return () => window.clearTimeout(t);
  }, [focusRequest?.nonce]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".xterm")) return;
      const action = findAction(e, getState().config?.keybindings ?? {});
      if (!action) return;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA");
      if (typing && !["palette", "home", "toggle_left_sidebar", "toggle_right_sidebar", "next_attention"].includes(action)) return;
      e.preventDefault();
      runAction(action);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (ui.view === "worktree" && worktree && loaded && !tab) rpc("worktree_open", { worktree_id: worktree.id }).catch(() => {});
  }, [ui.view, worktree?.id, loaded, tab?.id]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setState({ notice: null }), 4000);
    return () => window.clearTimeout(t);
  }, [notice?.nonce]);

  useEffect(() => {
    document.documentElement.dataset.theme = config?.theme ?? "system";
  }, [config?.theme]);

  const showWorktree = ui.view === "worktree" && worktree;
  return (
    <div className={`app${ui.leftOpen ? "" : " no-left"}${ui.rightOpen && showWorktree ? "" : " no-right"}`} style={{ ["--left-w" as string]: `${ui.leftWidth}px`, ["--right-w" as string]: `${ui.rightWidth}px` }}>
      <div className="titlebar" data-tauri-drag-region>
        <span className="titlebar-text" data-tauri-drag-region>
          <span>{showWorktree ? worktree.name : ui.view === "towns" ? "japan" : "home"}</span>
          {showWorktree && <span className="faint">{worktree.branch ?? ""}{worktree.git?.dirty ? " *" : ""}</span>}
        </span>
        <span className="spacer" data-tauri-drag-region />
        {attention > 0 && <button className="attention-btn" onClick={() => runAction("next_attention")} title="Jump to next attention item"><span className="state state-waiting" /> {attention} waiting</button>}
        {!connected && <span className="conn-bad">daemon offline</span>}
        <button className="ghost" title="Command palette" onClick={() => runAction("palette")}><span className="kbd">⌘K</span></button>
        <button className="ghost" title="Toggle left sidebar" onClick={() => setUi({ leftOpen: !ui.leftOpen })}><PanelLeft className="icon" /></button>
        {showWorktree && <button className="ghost" title="Toggle right sidebar" onClick={() => setUi({ rightOpen: !ui.rightOpen })}><PanelRight className="icon" /></button>}
      </div>
      {ui.leftOpen && <Sidebar />}
      <main className="center">
        {!loaded && <div className="center-empty muted">{connected ? "Loading…" : "Starting tomod…"}</div>}
        {loaded && !showWorktree && ui.view === "towns" && <Towns />}
        {loaded && !showWorktree && ui.view !== "towns" && <Home />}
        {loaded && showWorktree && (
          <>
            <TabBar worktreeId={worktree.id} />
            {tab ? <TabLayout key={tab.id} tab={tab} /> : <div className="center-empty muted">Opening…</div>}
          </>
        )}
      </main>
      {ui.rightOpen && showWorktree && <RightSidebar worktree={worktree} />}
      <Palette />
      <Dialogs />
      <ContextMenu />
      {notice && <div key={notice.nonce} className={`toast toast-${notice.level}`}>{notice.message}</div>}
    </div>
  );
}
