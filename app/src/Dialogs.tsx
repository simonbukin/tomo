import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { rpc } from "./api";
import { openWorktree } from "./actions";
import { Button, ConfirmDialog, Dialog, DialogActions, DialogContent, DialogTitle, SkeletonRows } from "./components/ui";
import { IntegrationStatusList, Settings } from "./Settings";
import { DiagnosticsDialog } from "./shell/Diagnostics";
import { InlineError } from "./states";
import { setState, useStore, type Dialog as DialogSpec } from "./store";
import type { ConfigIssue, HookRun, Repo, Town, Worktree } from "./types";

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
      <DialogContent width={shown.kind === "settings" ? 720 : undefined} className={shown.kind === "settings" ? "settings-dialog" : undefined}>
        {shown.kind === "add-repo" && <AddRepo close={close} />}
        {shown.kind === "create-worktree" && <CreateWorktree close={close} repoId={shown.repoId} />}
        {shown.kind === "prompt" && <Prompt close={close} title={shown.title} initial={shown.initial} placeholder={shown.placeholder} onSubmit={shown.onSubmit} />}
        {shown.kind === "integrations" && <IntegrationsDialog close={close} />}
        {shown.kind === "config-check" && <ConfigCheckDialog close={close} />}
        {shown.kind === "hook-log" && <HookLogDialog close={close} />}
        {shown.kind === "settings" && <Settings close={close} section={shown.section} />}
        {shown.kind === "diagnostics" && <DiagnosticsDialog close={close} />}
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
      const w = await rpc<Worktree>("worktree_create", { repo_id: repo, branch: branch.trim(), new_branch: isNew, start_ref: from.trim() || null, path: path.trim() || null, name_hint: path.trim() ? null : (town?.slug ?? null) });
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
  return (
    <>
      <DialogTitle>integration status</DialogTitle>
      <IntegrationStatusList />
      <DialogActions>
        <Button onClick={close}>Close</Button>
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
