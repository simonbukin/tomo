import { ChevronDown, ChevronRight, Copy, ExternalLink, Eye, File, Folder } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { rpc } from "./api";
import { openMenu } from "./MenuHost";
import { Select, SkeletonRows } from "./components/ui";
import { fileMenu } from "./menus";
import { setMetadata, spawnAgent } from "./actions";
import { ProcessIcon } from "./ProcessIcon";
import { orderedStates } from "./homeQuery";
import { failToast, formatBytes, useStore } from "./store";
import { inspectorSections } from "./addons";
import type { AgentSession, FsEntry, Id, ProcessInfo, Worktree } from "./types";

export function RightSidebar({ worktree }: { worktree: Worktree }) {
  const section = useStore((s) => s.ui.rightSection);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (section) ref.current?.querySelector(`[data-section="${section}"]`)?.scrollIntoView({ block: "nearest" });
  }, [section]);
  return (
    <aside className="rightbar" ref={ref}>
      <MetadataSection w={worktree} />
      <GitSection w={worktree} />
      {inspectorSections().map(({ id, component: Section }) => <Section key={id} worktree={worktree} />)}
      <ProcessSection w={worktree} />
      <SessionsSection w={worktree} />
      <FilesSection w={worktree} />
    </aside>
  );
}

function MetadataSection({ w }: { w: Worktree }) {
  const m = w.metadata;
  const states = useStore((s) => orderedStates(s.config?.states ?? []));
  const [name, setName] = useState(m.display_name ?? "");
  const [project, setProject] = useState(m.project ?? "");
  const [tags, setTags] = useState(m.tags.join(", "));
  useEffect(() => {
    setName(m.display_name ?? "");
    setProject(m.project ?? "");
    setTags(m.tags.join(", "));
  }, [w.id, m.display_name, m.project, m.tags.join(",")]);
  const commit = (patch: Record<string, unknown>) => setMetadata(w.id, patch);
  return (
    <section className="side-section" data-section="worktree">
      <div className="section-label">worktree</div>
      <div className="kv"><label>name</label><input value={name} placeholder={w.path.split("/").pop()} onChange={(e) => setName(e.target.value)} onBlur={() => commit({ display_name: name.trim() || null })} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} /></div>
      <div className="kv"><label>project</label><input value={project} onChange={(e) => setProject(e.target.value)} onBlur={() => commit({ project: project.trim() || null })} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} /></div>
      <div className="kv"><label>state</label>
        <Select
          aria-label="Workflow state"
          size="sm"
          value={m.state ?? ""}
          onValueChange={(v) => commit({ state: v || null })}
          options={[{ value: "", label: "no state" }, ...states.map((s) => ({ value: s.id, label: s.label })), ...(m.state && !states.some((s) => s.id === m.state) ? [{ value: m.state, label: m.state }] : [])]}
        />
      </div>
      <div className="kv"><label>tags</label><input value={tags} placeholder="a, b" onChange={(e) => setTags(e.target.value)} onBlur={() => commit({ tags: tags.split(",").map((t) => t.trim()).filter(Boolean) })} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} /></div>
    </section>
  );
}

function GitSection({ w }: { w: Worktree }) {
  const g = w.git;
  useEffect(() => {
    rpc("git_summary", { worktree_id: w.id }).catch(() => {});
    const t = window.setInterval(() => rpc("git_summary", { worktree_id: w.id }).catch(() => {}), 10_000);
    return () => window.clearInterval(t);
  }, [w.id]);
  return (
    <section className="side-section" data-section="git">
      <div className="section-label">git <button className="link" onClick={() => rpc("git_summary", { worktree_id: w.id }).catch(() => {})}>refresh</button></div>
      <div className="kv"><label>branch</label><span className="mono">{w.detached ? `detached ${w.head.slice(0, 7)}` : (w.branch ?? "—")}</span></div>
      {g ? (
        <>
          <div className="kv"><label>state</label><span>{g.dirty ? "dirty" : "clean"}</span></div>
          {g.files_changed > 0 && <div className="kv"><label>changed</label><span>{g.files_changed} file{g.files_changed === 1 ? "" : "s"}{g.untracked ? `, ${g.untracked} untracked` : ""}</span></div>}
          {!g.files_changed && g.untracked > 0 && <div className="kv"><label>untracked</label><span>{g.untracked}</span></div>}
          {(g.insertions > 0 || g.deletions > 0) && <div className="kv"><label>diff</label><span><span className="ins">+{g.insertions}</span> <span className="del">−{g.deletions}</span></span></div>}
          {g.upstream && <div className="kv"><label>upstream</label><span className="mono">{g.upstream}{g.ahead || g.behind ? ` (↑${g.ahead ?? 0} ↓${g.behind ?? 0})` : ""}</span></div>}
        </>
      ) : (
        <div className="muted">{w.exists ? "no status yet" : "worktree directory is missing"}</div>
      )}
    </section>
  );
}

function ProcessSection({ w }: { w: Worktree }) {
  const res = useStore((s) => s.resources[w.id]);
  const [open, setOpen] = useState(false);
  const [procs, setProcs] = useState<ProcessInfo[]>([]);
  useEffect(() => {
    if (!open) return;
    const load = () => rpc<ProcessInfo[]>("ps", { worktree_id: w.id }).then(setProcs).catch(() => {});
    load();
    const t = window.setInterval(load, 3000);
    return () => window.clearInterval(t);
  }, [open, w.id]);
  const kill = (pid: number) => rpc("process_kill_tree", { pid }).catch(failToast("Kill failed"));
  return (
    <section className="side-section" data-section="processes">
      <div className="section-label">processes <button className="link" onClick={() => setOpen(!open)}>{open ? "hide" : "show"}</button></div>
      {res ? (
        <div className="kv"><label>total</label><span>{res.process_count} proc · {res.cpu_percent.toFixed(0)}% cpu · {formatBytes(res.rss_bytes)}</span></div>
      ) : (
        <div className="muted">nothing running</div>
      )}
      {open && (
        <div className="proc-list">
          {[...procs].sort((a, b) => b.rss_bytes - a.rss_bytes).slice(0, 25).map((p) => (
            <div key={p.pid} className="proc-row" title={p.cmd}>
              <span className="num">{p.pid}</span>
              <span className="proc-name" style={{ paddingLeft: p.depth * 8 }}>{p.name}{p.ownership === "observed" ? <span className="muted"> (observed)</span> : null}</span>
              <span className="num">{formatBytes(p.rss_bytes)}</span>
              {p.ownership === "owned" && p.depth > 0 && <button className="link" title="Kill this process and its children" onClick={() => kill(p.pid)}>kill</button>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** Claude and Codex conversations that started in this worktree, read from the agents' own stores. */
function SessionsSection({ w }: { w: Worktree }) {
  const [items, setItems] = useState<AgentSession[] | null>(null);
  const live = useStore((s) => Object.values(s.agents).filter((a) => a.worktree_id === w.id && a.session_ref).map((a) => a.session_ref!));
  useEffect(() => {
    setItems(null);
    if (!w.exists) return;
    const load = () => rpc<AgentSession[]>("session_list", { worktree_id: w.id, limit: 8 }).then(setItems).catch(() => setItems([]));
    load();
    const t = window.setInterval(load, 30_000);
    return () => window.clearInterval(t);
  }, [w.id, w.exists, live.join(",")]);
  const resumable = (items ?? []).filter((s) => !live.includes(s.id));
  return (
    <section className="side-section" data-section="sessions">
      <div className="section-label">sessions{items && items.length > 0 && <span className="right">{items.length}</span>}</div>
      {items === null && w.exists && <SkeletonRows count={2} className="compact" label="looking for sessions" />}
      {items?.length === 0 && <div className="muted">no agent sessions rooted here</div>}
      {resumable.map((s) => (
        <div key={`${s.kind}-${s.id}`} className="session-row" title={`${s.path}\n${s.turns} turns`}>
          <ProcessIcon agent={s.kind} size={11} />
          <span className="session-title">{s.title ?? s.id.slice(0, 8)}</span>
          <span className="faint">{ago(s.updated_at_ms)}</span>
          <button className="link" onClick={() => spawnAgent(s.kind, w.id, { resume: s.id, newTab: true })}>resume</button>
        </div>
      ))}
    </section>
  );
}

function FilesSection({ w }: { w: Worktree }) {
  const [selected, setSelected] = useState<string>("");
  const [dirs, setDirs] = useState<Record<string, FsEntry[]>>({});
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set([""]));
  const load = (rel: string) => rpc<FsEntry[]>("fs_list", { worktree_id: w.id, rel_path: rel }).then((e) => setDirs((d) => ({ ...d, [rel]: e }))).catch(() => {});
  useEffect(() => {
    setDirs({});
    setOpenDirs(new Set([""]));
    setSelected("");
    if (w.exists) load("");
  }, [w.id, w.exists]);
  const toggle = (rel: string) => {
    const next = new Set(openDirs);
    if (next.has(rel)) next.delete(rel);
    else {
      next.add(rel);
      if (!dirs[rel]) load(rel);
    }
    setOpenDirs(next);
  };
  const act = (target: "finder" | "editor") => rpc("open_external", { worktree_id: w.id, rel_path: selected, target }).catch(failToast("Could not open"));
  const copy = () => navigator.clipboard.writeText(selected ? `${w.path}/${selected}` : w.path).catch(() => {});
  const render = (rel: string, depth: number): React.ReactNode =>
    (dirs[rel] ?? []).map((e) => (
      <div key={e.rel_path}>
        <div className={`file-row${selected === e.rel_path ? " file-selected" : ""}`} style={{ paddingLeft: 8 + depth * 12 }} onClick={() => { setSelected(e.rel_path); if (e.is_dir) toggle(e.rel_path); }} onContextMenu={(ev) => { setSelected(e.rel_path); openMenu(ev, fileMenu(w, e.rel_path)); }} onDoubleClick={() => !e.is_dir && rpc("open_external", { worktree_id: w.id, rel_path: e.rel_path, target: "editor" }).catch(() => {})}>
          {e.is_dir ? (openDirs.has(e.rel_path) ? <ChevronDown className="icon" /> : <ChevronRight className="icon" />) : <File className="icon" />} {e.name}
        </div>
        {e.is_dir && openDirs.has(e.rel_path) && render(e.rel_path, depth + 1)}
      </div>
    ));
  return (
    <section className="side-section side-files" data-section="files">
      <div className="section-label">files</div>
      <div className="file-actions">
        <button className="link" onClick={() => act("finder")}><Eye className="icon" /> reveal</button>
        <button className="link" onClick={copy}><Copy className="icon" /> copy path</button>
        <button className="link" onClick={() => act("editor")}><ExternalLink className="icon" /> editor</button>
      </div>
      <div className="file-tree">
        <div className={`file-row${selected === "" ? " file-selected" : ""}`} onClick={() => setSelected("")} onContextMenu={(ev) => { setSelected(""); openMenu(ev, fileMenu(w, "")); }}><Folder className="icon" /> {w.name}/</div>
        {render("", 1)}
      </div>
    </section>
  );
}

export type { Id };
