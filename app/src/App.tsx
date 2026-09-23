import { getCurrentWebview } from "@tauri-apps/api/webview";
import { lazy, Suspense, useEffect, type ComponentType } from "react";
import { addonViews, builtins } from "./addons";
import { onConnection, onFrame, rpc, rpcParsed, startEventPump } from "./api";
import { snapshotSchema } from "./schemas";
import { applyZoom, runAction } from "./actions";
import { zoomKey } from "./appearance";
import { applyTheme, useResolvedTheme } from "./theme";
import { TooltipProvider } from "./components/ui";
import { Activity } from "./Activity";
import { Agents } from "./Agents";
import { Apps } from "./Apps";
import { Dialogs } from "./Dialogs";
import { Home } from "./Home";
import { findAction } from "./keys";
import { BrowserHost } from "./browser/BrowserPane";
import { TabLayout } from "./Layout";
import { MenuHost } from "./MenuHost";
import { Palette } from "./Palette";
import { RightSidebar } from "./RightSidebar";
import { Settings } from "./Settings";
import { useAppMenu } from "./appMenu";
import { ShortcutReference } from "./ShortcutReference";
import { opensShortcutHelp } from "./shortcuts";
import { Sidebar } from "./Sidebar";
import {activeTab, applyFrame, applySnapshot, failQuietly, getState, keyBindings, setState, useStore} from "./store";
import { TabBar } from "./Tabs";
import { LayoutDnd } from "./LayoutDnd";
import { focusTerminal } from "./terminals";
import { CheckpointBanner } from "./WorktreeHeader";
import { BottomStrip } from "./shell/BottomStrip";
import { LeftRail } from "./shell/LeftRail";
import { ResizeHandle } from "./shell/ResizeHandle";
import { RightRail } from "./shell/RightRail";
import { shellLayout } from "./shell/sidebarMode";
import { ToastDock } from "./shell/ToastDock";
import { CenterHead } from "./shell/TopStrip";
import { ShellLoading } from "./states";
import { useWindowChrome, useWindowWidth } from "./windowChrome";

/** Dev-only harnesses, each behind its own URL hash. Never linked from the product. */
const DEV_ROUTES: Record<string, () => Promise<{ default: ComponentType }>> = {
  "#ui-torture": () => import("./dev/UiTorture").then((m) => ({ default: m.UiTorture })),
  "#ui-gallery": () => import("./dev/Gallery").then((m) => ({ default: m.Gallery })),
};

const devRoute = import.meta.env.DEV ? DEV_ROUTES[window.location.hash] : undefined;
const DevHarness = devRoute ? lazy(devRoute) : () => null;

/** The core views that fill the centre instead of Home. Home renders when no entry and no addon claims the view. */
const CORE_CENTER: Record<string, ComponentType> = { activity: Activity, agents: Agents, apps: Apps, settings: Settings };

export function App() {
  return (
    <TooltipProvider>
      {devRoute ? (
        <Suspense fallback={null}>
          <DevHarness />
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
  const tab = useStore((s) => activeTab(s, s.ui.view === "worktree" ? s.ui.activeWorktreeId : null));
  const focusRequest = useStore((s) => s.focusRequest);
  useWindowChrome();
  const windowWidth = useWindowWidth();
  useAppMenu();
  const theme = useResolvedTheme();

  useEffect(() => {
    const offFrame = onFrame(applyFrame);
    const offConn = onConnection((up) => {
      setState((s) => ({ connected: up, daemonHealth: up ? "healthy" : "reconnecting", connectionNonce: up ? s.connectionNonce + 1 : s.connectionNonce }));
      if (up) rpcParsed("subscribe", snapshotSchema).then(applySnapshot).catch(failQuietly("subscribe"));
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
    if (ui.view === "worktree" && worktree && loaded && !tab) rpc("worktree_open", { worktree_id: worktree.id }).catch(failQuietly("worktree_open"));
  }, [ui.view, worktree?.id, loaded, tab?.id]);

  const appearance = ui.appearance;
  useEffect(() => applyTheme(document.documentElement, theme), [theme]);

  useEffect(() => {
    try {
      getCurrentWebview().setZoom(appearance.zoom).catch(() => {});
    } catch {}
  }, [appearance.zoom]);

  const showWorktree = ui.view === "worktree" && worktree;
  const addonView = addonViews().find((v) => v.id === ui.view);
  const CoreCenter = CORE_CENTER[ui.view];
  const layout = shellLayout(ui, windowWidth, !!showWorktree);
  return (
    <div className="app" data-left={layout.left} data-right={layout.right} style={{ ["--left-col" as string]: `${layout.leftCol}px`, ["--right-col" as string]: `${layout.rightCol}px` }}>
      {layout.left === "open" && <Sidebar />}
      {layout.left === "minimal" && <LeftRail />}
      <main className="center">
        <CenterHead worktree={showWorktree ? worktree : null} layout={layout} />
        {!loaded && <ShellLoading connected={connected} />}
        {loaded && !showWorktree && addonView && (
          <Suspense fallback={<addonView.fallback />}>
            <addonView.component />
          </Suspense>
        )}
        {loaded && !showWorktree && CoreCenter && <CoreCenter />}
        {loaded && !showWorktree && !addonView && !CoreCenter && <Home />}
        {loaded && showWorktree && (
          <LayoutDnd>
            <CheckpointBanner worktree={worktree} />
            <TabBar worktreeId={worktree.id} />
            {tab ? <TabLayout key={tab.id} tab={tab} /> : <div className="center-empty muted">Opening...</div>}
          </LayoutDnd>
        )}
      </main>
      {showWorktree && layout.right === "open" && <RightSidebar worktree={worktree} />}
      {showWorktree && layout.right === "minimal" && <RightRail worktree={worktree} />}
      <ResizeHandle side="left" width={layout.leftCol} />
      {showWorktree && <ResizeHandle side="right" width={layout.rightCol} />}
      <Palette />
      <ShortcutReference />
      <Dialogs />
      {builtins.map((a) => a.mount && <a.mount key={a.id} />)}
      <BrowserHost />
      <BottomStrip left={layout.left} />
      <ToastDock />
    </div>
  );
}
