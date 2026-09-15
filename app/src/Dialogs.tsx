import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { rpc } from "./api";
import { Minus, Plus } from "lucide-react";
import { applyZoom, openWorktree, setAppearance } from "./actions";
import { ACCENTS, type ThemeChoice } from "./appearance";
import { Button, ConfirmDialog, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Select, SkeletonRows } from "./components/ui";
import { InlineError } from "./states";
import { notify, setState, useStore, type Dialog as DialogSpec } from "./store";
import type { ConfigIssue, HookRun, IntegrationStatus, Repo, Town, Worktree } from "./types";

/** Store-driven dialogs. The shell (portal, focus trap, Escape, focus return) comes from the Dialog primitive. */
export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  const last = useRef<DialogSpec | null>(null);
  if (dialog) last.current = dialog;
  const shown = dialog ?? last.current;
  if (!shown) return null;
  const close = () => setState({ dialog: null });
  const onOpenChange = (open: boolean) => !open && close();
  if (shown.kind === "confirm") {
    return <ConfirmDialog key={shown.title} open={!!dialog} onOpenChange={onOpenChange} title={shown.title} description={shown.body} confirmLabel={shown.confirmLabel} destructive={shown.destructive} check={shown.check} onConfirm={shown.onConfirm} />;
  }
  return (
    <Dialog open={!!dialog} onOpenChange={onOpenChange}>
      <DialogContent>
        {shown.kind === "add-repo" && <AddRepo close={close} />}
        {shown.kind === "create-worktree" && <CreateWorktree close={close} repoId={shown.repoId} />}
        {shown.kind === "prompt" && <Prompt close={close} title={shown.title} initial={shown.initial} placeholder={shown.placeholder} onSubmit={shown.onSubmit} />}
        {shown.kind === "integrations" && <IntegrationsDialog close={close} />}
        {shown.kind === "config-check" && <ConfigCheckDialog close={close} />}
        {shown.kind === "hook-log" && <HookLogDialog close={close} />}
        {shown.kind === "appearance" && <AppearanceDialog close={close} />}
      </DialogContent>
    </Dialog>
  );
}

function Prompt({ close, title, initial, placeholder, onSubmit }: { close: () => void; title: string; initial: string; placeholder?: string; onSubmit: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  const submit = () => {
    close();
    onSubmit(value);
  };
  return (
    <>
      <DialogTitle>{title}</DialogTitle>
      <input value={value} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
      <DialogActions>
        <Button onClick={close}>Cancel</Button>
        <Button variant="default" onClick={submit}>Save</Button>
      </DialogActions>
    </>
  );
}

function AddRepo({ close }: { close: () => void }) {
  const [path, setPath] = useState("");
  const [url, setUrl] = useState("");
  const [dest, setDest] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      if (url.trim()) await rpc<Repo>("repo_clone", { url: url.trim(), dest: dest.trim() });
      else await rpc<Repo>("repo_add", { path: path.trim() });
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const browse = async () => {
    const picked = await pickFolder({ directory: true, multiple: false }).catch(() => null);
    if (typeof picked === "string") setPath(picked);
  };
  return (
    <>
      <DialogTitle>Add repository</DialogTitle>
      <label>Existing repository path</label>
      <div className="row">
        <input className="mono" value={path} placeholder="/path/to/repo" onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <Button onClick={browse}>Browse…</Button>
      </div>
      <label>Or clone</label>
      <input className="mono" value={url} placeholder="git@github.com:org/repo.git" onChange={(e) => setUrl(e.target.value)} />
      <input className="mono" value={dest} placeholder="/destination/path" onChange={(e) => setDest(e.target.value)} />
      {error && <InlineError>{error}</InlineError>}
      <DialogActions>
        <Button onClick={close}>Cancel</Button>
        <Button variant="default" disabled={busy || (!path.trim() && !(url.trim() && dest.trim()))} onClick={add}>
          {busy ? "Working…" : "Add"}
        </Button>
      </DialogActions>
    </>
  );
}

function CreateWorktree({ close, repoId }: { close: () => void; repoId?: string }) {
  const repos = useStore((s) => s.repos);
  const config = useStore((s) => s.config);
  const [repo, setRepo] = useState(repoId ?? repos[0]?.id ?? "");
  const [branch, setBranch] = useState("");
  const [isNew, setIsNew] = useState(true);
  const [from, setFrom] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [town, setTown] = useState<Town | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reroll = () => rpc<Town>("town_pick").then(setTown).catch(() => setTown(null));
  useEffect(() => {
    reroll();
  }, []);
  useEffect(() => {
    if (!repo && repos[0]) setRepo(repos[0].id);
  }, [repos, repo]);
  const r = repos.find((x) => x.id === repo);
  const parent = r ? (config?.worktree_parent_dir ?? r.path.replace(/\/[^/]+$/, "")) : "";
  const defaultPath = r ? `${parent}/${town?.slug ?? "<town>"}` : "";
  const create = async () => {
    if (!repo || !branch.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const w = await rpc<Worktree>("worktree_create", { repo_id: repo, branch: branch.trim(), new_branch: isNew, start_ref: from.trim() || null, path: path.trim() || null, town_slug: path.trim() ? null : (town?.slug ?? null) });
      close();
      openWorktree(w.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <DialogTitle>New worktree</DialogTitle>
      <label>Repository</label>
      <select value={repo} onChange={(e) => setRepo(e.target.value)}>
        {repos.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
      </select>
      <label>Branch</label>
      <input className="mono" value={branch} placeholder="feature/thing" onChange={(e) => setBranch(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} />
      <label className="check">
        <input type="checkbox" checked={isNew} onChange={(e) => setIsNew(e.target.checked)} /> create this branch
      </label>
      {isNew && (
        <>
          <label>Start from (optional ref)</label>
          <input className="mono" value={from} placeholder="main" onChange={(e) => setFrom(e.target.value)} />
        </>
      )}
      <label>Location</label>
      <input className="mono" value={path} placeholder={defaultPath} onChange={(e) => setPath(e.target.value)} />
      {!path.trim() && town && (
        <div className="town-suggest rise">
          <span className={`rarity-dot rarity-${town.rarity}`} />
          <span>{town.name}</span>
          <span className="muted">{town.ja}</span>
          <span className="faint">
            {town.pref} · {town.rarity}
          </span>
          <Button variant="link" onClick={reroll}>reroll</Button>
        </div>
      )}
      {error && <InlineError>{error}</InlineError>}
      <DialogActions>
        <Button onClick={close}>Cancel</Button>
        <Button variant="default" disabled={busy || !repo || !branch.trim()} onClick={create}>
          {busy ? "Creating…" : "Create"}
        </Button>
      </DialogActions>
    </>
  );
}

function useRpcList<T>(method: string, params?: Record<string, unknown>): { items: T[] | null; error: string | null; reload: () => void } {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () =>
    rpc<T[]>(method, params)
      .then((list) => {
        setError(null);
        setItems(list);
      })
      .catch((e) => {
        setError((e as Error).message);
        setItems([]);
      });
  useEffect(() => {
    reload();
  }, [method]);
  return { items, error, reload };
}

function IntegrationsDialog({ close }: { close: () => void }) {
  const { items, error, reload } = useRpcList<IntegrationStatus>("integrations_status");
  const [busy, setBusy] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const install = async () => {
    setBusy(true);
    setInstallError(null);
    try {
      await rpc("integrations_install");
      notify("info", "hooks installed");
      reload();
    } catch (e) {
      setInstallError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <DialogTitle>integration status</DialogTitle>
      {(error || installError) && <InlineError>{installError ?? error}</InlineError>}
      <div className="dialog-list">
        {items === null && <SkeletonRows count={3} className="compact" label="checking integrations" />}
        {items?.map((i) => (
          <div key={i.kind} className="dialog-row" title={i.binary ?? "binary not found"}>
            <span className={`state state-${i.level}`} />
            <span className="name">{i.kind}</span>
            <span className="detail">
              {i.level.replace("_", " ")}
              {i.reason ? ` · ${i.reason}` : ""}
              {i.lifecycle ? "" : " · no lifecycle"}
              {i.resume ? "" : " · no resume"}
            </span>
          </div>
        ))}
      </div>
      <DialogActions>
        <Button onClick={close}>Close</Button>
        <Button variant="default" disabled={busy} onClick={install}>
          {busy ? "Installing…" : "install hooks"}
        </Button>
      </DialogActions>
    </>
  );
}

function ConfigCheckDialog({ close }: { close: () => void }) {
  const { items, error } = useRpcList<ConfigIssue>("config_check");
  return (
    <>
      <DialogTitle>config check</DialogTitle>
      {error && <InlineError>{error}</InlineError>}
      <div className="dialog-list">
        {items === null && <SkeletonRows count={3} className="compact" label="checking config" />}
        {items?.length === 0 && !error && <div className="muted">no issues</div>}
        {items?.map((i, n) => (
          <div key={`${i.key}-${n}`} className="dialog-row">
            <span className={`state state-${i.level}`} />
            <span className="name mono">{i.key}</span>
            <span className="detail" title={i.message}>
              {i.message}
            </span>
          </div>
        ))}
      </div>
      <DialogActions>
        <Button onClick={close}>Close</Button>
      </DialogActions>
    </>
  );
}

function HookLogDialog({ close }: { close: () => void }) {
  const { items, error } = useRpcList<HookRun>("hook_log", { limit: 20 });
  const [open, setOpen] = useState<number | null>(null);
  return (
    <>
      <DialogTitle>hook log</DialogTitle>
      {error && <InlineError>{error}</InlineError>}
      <div className="dialog-list">
        {items === null && <SkeletonRows count={3} className="compact" label="loading hook runs" />}
        {items?.length === 0 && !error && <div className="muted">no hook runs yet</div>}
        {items?.map((r, n) => (
          <div key={`${r.started_at_ms}-${n}`} className="dialog-row hook-row" onClick={() => setOpen(open === n ? null : n)}>
            <span className={`state state-${r.ok ? "ok" : "fail"}`} />
            <span className="name mono">{r.event}</span>
            <span className="detail mono" title={r.command}>
              {r.command} · {r.duration_ms} ms{r.exit_code != null && !r.ok ? ` · exit ${r.exit_code}` : ""}
            </span>
            {open === n && <pre className="hook-out">{r.output_tail.trim() || "(no output)"}</pre>}
          </div>
        ))}
      </div>
      <DialogActions>
        <Button onClick={close}>Close</Button>
      </DialogActions>
    </>
  );
}

function AppearanceDialog({ close }: { close: () => void }) {
  const a = useStore((s) => s.ui.appearance);
  const configFont = useStore((s) => s.config?.font_size ?? 13);
  const font = a.terminalFontSize ?? configFont;
  const themes: { value: ThemeChoice; label: string }[] = [
    { value: "system", label: "system" },
    { value: "light", label: "light" },
    { value: "dark", label: "dark" },
  ];
  return (
    <>
      <DialogTitle>appearance</DialogTitle>
      <div className="appearance-grid">
        <label>theme</label>
        <Select<ThemeChoice> aria-label="Theme" size="sm" value={a.theme} onValueChange={(theme) => setAppearance({ theme })} options={themes} />
        <label>accent</label>
        <span className="swatches">
          {ACCENTS.map((x) => (
            <button key={x.id} className="swatch" aria-pressed={a.accent === x.id} onClick={() => setAppearance({ accent: x.id })}>
              <span className={`swatch-dot ${x.id}`} />
              {x.label}
            </button>
          ))}
        </span>
        <label>zoom</label>
        <span className="stepper">
          <IconButton label="Zoom out" onClick={() => applyZoom("out")}>
            <Minus className="icon" />
          </IconButton>
          <span className="value">{Math.round(a.zoom * 100)}%</span>
          <IconButton label="Zoom in" onClick={() => applyZoom("in")}>
            <Plus className="icon" />
          </IconButton>
          {a.zoom !== 1 && <Button variant="link" onClick={() => applyZoom("reset")}>reset</Button>}
        </span>
        <label>terminal font</label>
        <span className="stepper">
          <IconButton label="Smaller terminal font" onClick={() => setAppearance({ terminalFontSize: Math.max(8, font - 1) })}>
            <Minus className="icon" />
          </IconButton>
          <span className="value">{font}px</span>
          <IconButton label="Larger terminal font" onClick={() => setAppearance({ terminalFontSize: Math.min(32, font + 1) })}>
            <Plus className="icon" />
          </IconButton>
          {a.terminalFontSize != null && <Button variant="link" onClick={() => setAppearance({ terminalFontSize: null })}>use config</Button>}
        </span>
      </div>
      <p className="faint">⌘ + and ⌘ − zoom the whole window; ⌘ 0 resets. Ctrl works too.</p>
      <DialogActions>
        <Button onClick={close}>Done</Button>
      </DialogActions>
    </>
  );
}
