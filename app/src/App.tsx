import { getCurrentWebview } from "@tauri-apps/api/webview";
import { PanelLeft, PanelRight, Settings2 } from "lucide-react";
import { lazy, Suspense, useEffect } from "react";
import { onConnection, onFrame, rpc, startEventPump } from "./api";
import { applyZoom, runAction } from "./actions";
import { zoomKey } from "./appearance";
import { openSettings } from "./commands/settings";
import { applyTheme, useResolvedTheme } from "./theme";
import { Button, IconButton, TooltipProvider } from "./components/ui";
import { Activity } from "./Activity";
import { Dialogs } from "./Dialogs";
import { Home } from "./Home";
import { findAction } from "./keys";
import { TabLayout } from "./Layout";
import { MenuHost } from "./MenuHost";
import { Palette } from "./Palette";
import { RightSidebar } from "./RightSidebar";
import { useAppMenu } from "./appMenu";
import { ShortcutReference } from "./ShortcutReference";
import { opensShortcutHelp, useShortcuts } from "./shortcuts";
import { Sidebar } from "./Sidebar";
import { activeTab, applyFrame, applySnapshot, getState, keyBindings, needsMe, repoName, setState, useStore } from "./store";
import { TabBar } from "./Tabs";
import { LayoutDnd } from "./LayoutDnd";
import { focusTerminal } from "./terminals";
import type { Snapshot } from "./types";
import { WorktreeHeader } from "./WorktreeHeader";
import { BottomStrip } from "./shell/BottomStrip";
import { ToastDock } from "./shell/ToastDock";
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
  const attention = useStore((s) => needsMe(s).length);
  useWindowChrome();
  const shortcut = useShortcuts();
  useAppMenu();
  const theme = useResolvedTheme();

  useEffect(() => {
    const offFrame = onFrame(applyFrame);
    const offConn = onConnection((up) => {
      setState((s) => ({ connected: up, daemonHealth: up ? "healthy" : "reconnecting", connectionNonce: up ? s.connectionNonce + 1 : s.connectionNonce }));
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
      if (opensShortcutHelp(e)) {
        e.preventDefault();
        runAction("keyboard_shortcuts");
        return;
      }
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

  const appearance = ui.appearance;
  useEffect(() => applyTheme(document.documentElement, theme), [theme]);

  useEffect(() => {
    try {
      getCurrentWebview().setZoom(appearance.zoom).catch(() => {});
    } catch {}
  }, [appearance.zoom]);

  const showWorktree = ui.view === "worktree" && worktree;
  return (
    <div className={`app${ui.leftMode === "closed" ? " no-left" : ""}${ui.rightMode !== "closed" && showWorktree ? "" : " no-right"}`} style={{ ["--left-w" as string]: `${ui.leftWidth}px`, ["--right-w" as string]: `${ui.rightWidth}px` }}>
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
        <IconButton label="Settings" shortcut={shortcut("settings")} onClick={() => openSettings()}>
          <Settings2 className="icon" />
        </IconButton>
        <IconButton label="Command palette" shortcut={shortcut("palette")} onClick={() => runAction("palette")}>
          <span className="kbd">{shortcut("palette") ?? "⌘K"}</span>
        </IconButton>
        <IconButton label="Toggle sidebar" shortcut={shortcut("toggle_left_sidebar")} onClick={() => runAction("toggle_left_sidebar")}>
          <PanelLeft className="icon" />
        </IconButton>
        {showWorktree && (
          <IconButton label="Toggle inspector" shortcut={shortcut("toggle_right_sidebar")} onClick={() => runAction("toggle_right_sidebar")}>
            <PanelRight className="icon" />
          </IconButton>
        )}
      </div>
      {ui.leftMode !== "closed" && <Sidebar />}
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
          <LayoutDnd>
            <WorktreeHeader worktree={worktree} />
            <TabBar worktreeId={worktree.id} />
            {tab ? <TabLayout key={tab.id} tab={tab} /> : <div className="center-empty muted">Opening…</div>}
          </LayoutDnd>
        )}
      </main>
      {ui.rightMode !== "closed" && showWorktree && <RightSidebar worktree={worktree} />}
      <Palette />
      <ShortcutReference />
      <Dialogs />
      <TownReveal />
      <BottomStrip />
      <ToastDock />
    </div>
  );
}
