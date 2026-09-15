import { getCurrentWebview } from "@tauri-apps/api/webview";
import { PanelLeft, PanelRight, SunMoon } from "lucide-react";
import { lazy, Suspense, useEffect } from "react";
import { onConnection, onFrame, rpc, startEventPump } from "./api";
import { applyZoom, runAction } from "./actions";
import { effectiveTheme, zoomKey } from "./appearance";
import { Button, IconButton, TooltipProvider } from "./components/ui";
import { Activity } from "./Activity";
import { Dialogs } from "./Dialogs";
import { Home } from "./Home";
import { findAction } from "./keys";
import { TabLayout } from "./Layout";
import { MenuHost } from "./MenuHost";
import { Palette } from "./Palette";
import { RightSidebar } from "./RightSidebar";
import { Sidebar } from "./Sidebar";
import { activeTab, applyFrame, applySnapshot, getState, keyBindings, needsMe, repoName, setState, setUi, useStore } from "./store";
import { TabBar } from "./Tabs";
import { focusTerminal } from "./terminals";
import type { Snapshot } from "./types";
import { WorktreeHeader } from "./WorktreeHeader";
import { MapLoading, ShellLoading } from "./states";
import { TownReveal } from "./TownReveal";
import { useWindowChrome } from "./windowChrome";

const Towns = lazy(() => import("./Towns").then((m) => ({ default: m.Towns })));
const tortureRoute = import.meta.env.DEV && window.location.hash === "#ui-torture";
const UiTorture = tortureRoute ? lazy(() => import("./dev/UiTorture").then((m) => ({ default: m.UiTorture }))) : () => null;

export function App() {
  return (
    <TooltipProvider>
      {tortureRoute ? (
        <Suspense fallback={null}>
          <UiTorture />
        </Suspense>
      ) : (
        <Shell />
      )}
      <MenuHost />
    </TooltipProvider>
  );
}

function Shell() {
  const connected = useStore((s) => s.connected);
  const loaded = useStore((s) => s.loaded);
  const ui = useStore((s) => s.ui);
  const worktree = useStore((s) => s.worktrees.find((w) => w.id === s.ui.activeWorktreeId) ?? null);
  const repo = useStore((s) => (worktree ? repoName(s, worktree.repo_id) : ""));
  const tab = useStore((s) => activeTab(s, s.ui.view === "worktree" ? s.ui.activeWorktreeId : null));
  const focusRequest = useStore((s) => s.focusRequest);
  const notice = useStore((s) => s.notice);
  const attention = useStore((s) => needsMe(s).length);
  const config = useStore((s) => s.config);
  useWindowChrome();

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
      const zoom = zoomKey(e);
      if (zoom) {
        e.preventDefault();
        applyZoom(zoom);
        return;
      }
      const action = findAction(e, keyBindings(getState()));
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

  const appearance = ui.appearance;
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = effectiveTheme(appearance.theme, config?.theme);
    root.dataset.accent = appearance.accent;
  }, [appearance.theme, appearance.accent, config?.theme]);

  useEffect(() => {
    try {
      getCurrentWebview().setZoom(appearance.zoom).catch(() => {});
    } catch {}
  }, [appearance.zoom]);

  const showWorktree = ui.view === "worktree" && worktree;
  return (
    <div className={`app${ui.leftOpen ? "" : " no-left"}${ui.rightOpen && showWorktree ? "" : " no-right"}`} style={{ ["--left-w" as string]: `${ui.leftWidth}px`, ["--right-w" as string]: `${ui.rightWidth}px` }}>
      <div className="titlebar" data-tauri-drag-region>
        <span className="titlebar-text" data-tauri-drag-region>
          {showWorktree ? repo : ui.view === "towns" ? "japan" : ui.view === "activity" ? "activity" : "home"}
        </span>
        <span className="spacer" data-tauri-drag-region />
        {attention > 0 && (
          <Button className="attention-btn" size="sm" onClick={() => runAction("next_attention")}>
            <span className="state state-waiting" /> {attention} need you
          </Button>
        )}
        {!connected && <span className="conn-bad" data-tauri-drag-region>daemon offline</span>}
        {appearance.zoom !== 1 && (
          <Button variant="ghost" size="sm" className="zoom-chip" onClick={() => applyZoom("reset")}>
            {Math.round(appearance.zoom * 100)}%
          </Button>
        )}
        <IconButton label="Appearance" onClick={() => setState({ dialog: { kind: "appearance" } })}>
          <SunMoon className="icon" />
        </IconButton>
        <IconButton label="Command palette (⌘K)" onClick={() => runAction("palette")}>
          <span className="kbd">⌘K</span>
        </IconButton>
        <IconButton label={ui.leftOpen ? "Hide sidebar" : "Show sidebar"} onClick={() => setUi({ leftOpen: !ui.leftOpen })}>
          <PanelLeft className="icon" />
        </IconButton>
        {showWorktree && (
          <IconButton label={ui.rightOpen ? "Hide inspector" : "Show inspector"} onClick={() => setUi({ rightOpen: !ui.rightOpen })}>
            <PanelRight className="icon" />
          </IconButton>
        )}
      </div>
      {ui.leftOpen && <Sidebar />}
      <main className="center">
        {!loaded && <ShellLoading connected={connected} />}
        {loaded && !showWorktree && ui.view === "towns" && (
          <Suspense fallback={<MapLoading />}>
            <Towns />
          </Suspense>
        )}
        {loaded && !showWorktree && ui.view === "activity" && <Activity />}
        {loaded && !showWorktree && ui.view !== "towns" && ui.view !== "activity" && <Home />}
        {loaded && showWorktree && (
          <>
            <WorktreeHeader worktree={worktree} />
            <TabBar worktreeId={worktree.id} />
            {tab ? <TabLayout key={tab.id} tab={tab} /> : <div className="center-empty muted">Opening…</div>}
          </>
        )}
      </main>
      {ui.rightOpen && showWorktree && <RightSidebar worktree={worktree} />}
      <Palette />
      <Dialogs />
      <TownReveal />
      {notice && (
        <div key={notice.nonce} className={`toast toast-${notice.level}`} role="status">
          {notice.message}
        </div>
      )}
    </div>
  );
}
