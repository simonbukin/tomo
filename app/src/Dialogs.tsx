import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { rpc } from "./api";
import { openWorktree } from "./actions";
import { notify, setState, useStore } from "./store";
import type { ConfigIssue, HookRun, IntegrationStatus, Repo, Town, Worktree } from "./types";

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  if (!dialog) return null;
  const close = () => setState({ dialog: null });
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && close()}>
        {dialog.kind === "add-repo" && <AddRepo close={close} />}
        {dialog.kind === "create-worktree" && <CreateWorktree close={close} repoId={dialog.repoId} />}
        {dialog.kind === "confirm" && <Confirm close={close} title={dialog.title} body={dialog.body} confirmLabel={dialog.confirmLabel} check={dialog.check} onConfirm={dialog.onConfirm} />}
        {dialog.kind === "prompt" && <Prompt close={close} title={dialog.title} initial={dialog.initial} placeholder={dialog.placeholder} onSubmit={dialog.onSubmit} />}
        {dialog.kind === "integrations" && <IntegrationsDialog close={close} />}
        {dialog.kind === "config-check" && <ConfigCheckDialog close={close} />}
        {dialog.kind === "hook-log" && <HookLogDialog close={close} />}
      </div>
    </div>
  );
}

function Confirm({ close, title, body, confirmLabel, check, onConfirm }: { close: () => void; title: string; body: string; confirmLabel: string; check?: string; onConfirm: (checked: boolean) => void }) {
  const [checked, setChecked] = useState(false);
  return (
    <>
      <h2>{title}</h2>
      <p>{body}</p>
      {check && <label className="check"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> {check}</label>}
      <div className="dialog-actions">
        <button onClick={close}>Cancel</button>
        <button className="primary" autoFocus onClick={() => { close(); onConfirm(checked); }}>{confirmLabel}</button>
      </div>
    </>
  );
}

function Prompt({ close, title, initial, placeholder, onSubmit }: { close: () => void; title: string; initial: string; placeholder?: string; onSubmit: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  const submit = () => { close(); onSubmit(value); };
  return (
    <>
      <h2>{title}</h2>
      <input autoFocus value={value} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
      <div className="dialog-actions">
        <button onClick={close}>Cancel</button>
        <button className="primary" onClick={submit}>Save</button>
      </div>
    </>
  );
}

function AddRepo({ close }: { close: () => void }) {
  const [path, setPath] = useState("");
  const [url, setUrl] = useState("");
  const [dest, setDest] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      if (url.trim()) await rpc<Repo>("repo_clone", { url: url.trim(), dest: dest.trim() });
      else await rpc<Repo>("repo_add", { path: path.trim() });
      close();
    } catch (e) {
      notify("error", (e as Error).message);
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
      <h2>Add repository</h2>
      <label>Existing repository path</label>
      <div className="row">
        <input autoFocus value={path} placeholder="/path/to/repo" onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <button onClick={browse}>Browse…</button>
      </div>
      <label>Or clone</label>
      <input value={url} placeholder="git@github.com:org/repo.git" onChange={(e) => setUrl(e.target.value)} />
      <input value={dest} placeholder="/destination/path" onChange={(e) => setDest(e.target.value)} />
      <div className="dialog-actions">
        <button onClick={close}>Cancel</button>
        <button className="primary" disabled={busy || (!path.trim() && !(url.trim() && dest.trim()))} onClick={add}>{busy ? "Working…" : "Add"}</button>
      </div>
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
  const reroll = () => rpc<Town>("town_pick").then(setTown).catch(() => setTown(null));
  useEffect(() => { reroll(); }, []);
  useEffect(() => { if (!repo && repos[0]) setRepo(repos[0].id); }, [repos, repo]);
  const r = repos.find((x) => x.id === repo);
  const parent = r ? (config?.worktree_parent_dir ?? r.path.replace(/\/[^/]+$/, "")) : "";
  const defaultPath = r ? `${parent}/${town?.slug ?? "<town>"}` : "";
  const create = async () => {
    if (!repo || !branch.trim()) return;
    setBusy(true);
    try {
      const w = await rpc<Worktree>("worktree_create", { repo_id: repo, branch: branch.trim(), new_branch: isNew, start_ref: from.trim() || null, path: path.trim() || null, town_slug: path.trim() ? null : town?.slug ?? null });
      close();
      openWorktree(w.id);
    } catch (e) {
      notify("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h2>New worktree</h2>
      <label>Repository</label>
      <select value={repo} onChange={(e) => setRepo(e.target.value)}>
        {repos.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </select>
      <label>Branch</label>
      <input autoFocus value={branch} placeholder="feature/thing" onChange={(e) => setBranch(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} />
      <label className="check"><input type="checkbox" checked={isNew} onChange={(e) => setIsNew(e.target.checked)} /> create this branch</label>
      {isNew && (<><label>Start from (optional ref)</label><input value={from} placeholder="main" onChange={(e) => setFrom(e.target.value)} /></>)}
      <label>Location</label>
      <input value={path} placeholder={defaultPath} onChange={(e) => setPath(e.target.value)} />
      {!path.trim() && town && (
        <div className="town-suggest rise">
          <span className={`rarity-dot rarity-${town.rarity}`} />
          <span>{town.name}</span>
          <span className="muted">{town.ja}</span>
          <span className="faint">{town.pref} · {town.rarity}</span>
          <button className="link" onClick={reroll}>reroll</button>
        </div>
      )}
      <div className="dialog-actions">
        <button onClick={close}>Cancel</button>
        <button className="primary" disabled={busy || !repo || !branch.trim()} onClick={create}>{busy ? "Creating…" : "Create"}</button>
      </div>
    </>
  );
}

function useRpcList<T>(method: string, params?: Record<string, unknown>): { items: T[] | null; reload: () => void } {
  const [items, setItems] = useState<T[] | null>(null);
  const reload = () => rpc<T[]>(method, params).then(setItems).catch((e) => { notify("error", (e as Error).message); setItems([]); });
  useEffect(() => { reload(); }, [method]);
  return { items, reload };
}

function IntegrationsDialog({ close }: { close: () => void }) {
  const { items, reload } = useRpcList<IntegrationStatus>("integrations_status");
  const [busy, setBusy] = useState(false);
  const install = async () => {
    setBusy(true);
    try {
      await rpc("integrations_install");
      notify("info", "hooks installed");
      reload();
    } catch (e) {
      notify("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h2>integration status</h2>
      <div className="dialog-list">
        {items === null && <div className="faint">checking…</div>}
        {items?.map((i) => (
          <div key={i.kind} className="dialog-row" title={i.binary ?? "binary not found"}>
            <span className={`state state-${i.level}`} />
            <span className="name">{i.kind}</span>
            <span className="detail">{i.level.replace("_", " ")}{i.reason ? ` · ${i.reason}` : ""}{i.lifecycle ? "" : " · no lifecycle"}{i.resume ? "" : " · no resume"}</span>
          </div>
        ))}
      </div>
      <div className="dialog-actions">
        <button onClick={close}>Close</button>
        <button className="primary" disabled={busy} onClick={install}>{busy ? "Installing…" : "install hooks"}</button>
      </div>
    </>
  );
}

function ConfigCheckDialog({ close }: { close: () => void }) {
  const { items } = useRpcList<ConfigIssue>("config_check");
  return (
    <>
      <h2>config check</h2>
      <div className="dialog-list">
        {items === null && <div className="faint">checking…</div>}
        {items?.length === 0 && <div className="muted">no issues</div>}
        {items?.map((i, n) => (
          <div key={`${i.key}-${n}`} className="dialog-row">
            <span className={`state state-${i.level}`} />
            <span className="name">{i.key}</span>
            <span className="detail" title={i.message}>{i.message}</span>
          </div>
        ))}
      </div>
      <div className="dialog-actions"><button onClick={close}>Close</button></div>
    </>
  );
}

function HookLogDialog({ close }: { close: () => void }) {
  const { items } = useRpcList<HookRun>("hook_log", { limit: 20 });
  const [open, setOpen] = useState<number | null>(null);
  return (
    <>
      <h2>hook log</h2>
      <div className="dialog-list">
        {items === null && <div className="faint">loading…</div>}
        {items?.length === 0 && <div className="muted">no hook runs yet</div>}
        {items?.map((r, n) => (
          <div key={`${r.started_at_ms}-${n}`} className="dialog-row hook-row" onClick={() => setOpen(open === n ? null : n)}>
            <span className={`state state-${r.ok ? "ok" : "fail"}`} />
            <span className="name">{r.event}</span>
            <span className="detail" title={r.command}>{r.command} · {r.duration_ms} ms{r.exit_code != null && !r.ok ? ` · exit ${r.exit_code}` : ""}</span>
            {open === n && <pre className="hook-out">{r.output_tail.trim() || "(no output)"}</pre>}
          </div>
        ))}
      </div>
      <div className="dialog-actions"><button onClick={close}>Close</button></div>
    </>
  );
}
