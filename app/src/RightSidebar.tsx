import { ChevronDown, ChevronRight, File, Folder, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { rpc, rpcParsed } from "./api";
import { agentSessionSchema, fsEntrySchema, processInfoSchema } from "./schemas";
import { openMenu } from "./MenuHost";
import { Combobox, IconButton, plainTextInput, Select, SkeletonRows, Tooltip } from "./components/ui";
import { fileMenu } from "./menus";
import { setMetadata, spawnAgent } from "./actions";
import { ProcessIcon } from "./ProcessIcon";
import { orderedStates } from "./homeQuery";
import { useFlip } from "./useFlip";
import { InspectorSection } from "./sections";
import {failQuietly, failToast, formatBytes, useStore} from "./store";
import { gitDetails, inspectorSections } from "./addons";
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
  const projects = useStore((s) => [...new Set(s.worktrees.map((x) => x.metadata.project).filter((p): p is string => !!p))].sort());
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
    <InspectorSection id="worktree">
      <div className="kv"><label>name</label><input value={name} placeholder={w.path.split("/").pop()} {...plainTextInput} onChange={(e) => setName(e.target.value)} onBlur={() => commit({ display_name: name.trim() || null })} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} /></div>
      <div className="kv"><label>project</label>
        <Combobox
          aria-label="Project"
          value={project}
          items={projects}
          placeholder="none"
          onValueChange={setProject}
          onSelect={(v) => commit({ project: v })}
          onBlur={() => commit({ project: project.trim() || null })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      </div>
      <div className="kv"><label>state</label>
        <Select
          aria-label="Workflow state"
          size="sm"
          value={m.state ?? ""}
          onValueChange={(v) => commit({ state: v || null })}
          options={[{ value: "", label: "no state" }, ...states.map((s) => ({ value: s.id, label: s.label })), ...(m.state && !states.some((s) => s.id === m.state) ? [{ value: m.state, label: m.state }] : [])]}
        />
      </div>
      <div className="kv"><label>tags</label><input value={tags} placeholder="a, b" {...plainTextInput} onChange={(e) => setTags(e.target.value)} onBlur={() => commit({ tags: tags.split(",").map((t) => t.trim()).filter(Boolean) })} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} /></div>
    </InspectorSection>
  );
}

function GitSection({ w }: { w: Worktree }) {
  const g = w.git;
  useEffect(() => {
    rpc("git_summary", { worktree_id: w.id }).catch(failQuietly("git_summary"));
    const t = window.setInterval(() => rpc("git_summary", { worktree_id: w.id }).catch(failQuietly("git_summary")), 10_000);
    return () => window.clearInterval(t);
  }, [w.id]);
  return (
    <InspectorSection id="git" control={<IconButton label="Refresh git status" onClick={() => rpc("git_summary", { worktree_id: w.id }).catch(failToast("Refresh failed"))}><RotateCw className="icon" /></IconButton>}>
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
      {gitDetails().map(({ id, component: Detail }) => <Detail key={id} worktree={w} />)}
    </InspectorSection>
  );
}

function ProcessSection({ w }: { w: Worktree }) {
  const res = useStore((s) => s.resources[w.id]);
  const [procs, setProcs] = useState<ProcessInfo[]>([]);
  useEffect(() => {
    const load = () => rpcParsed("ps", z.array(processInfoSchema), { worktree_id: w.id }).then(setProcs).catch(failQuietly("ps"));
    load();
    const t = window.setInterval(load, 3000);
    return () => window.clearInterval(t);
  }, [w.id]);
  const kill = (pid: number) => rpc("process_kill_tree", { pid }).catch(failToast("Kill failed"));
  const rows = [...procs].sort((a, b) => b.rss_bytes - a.rss_bytes).slice(0, 25);
  const list = useRef<HTMLDivElement>(null);
  useFlip(list, [rows.map((p) => p.pid).join(",")]);
  return (
    <InspectorSection id="processes">
      {res ? (
        <div className="proc-total">
          <span><span className="proc-total-key">processes</span><span className="proc-total-value">{res.process_count}</span></span>
          <span><span className="proc-total-key">cpu</span><span className="proc-total-value">{res.cpu_percent.toFixed(0)}%</span></span>
          <span><span className="proc-total-key">memory</span><span className="proc-total-value">{formatBytes(res.rss_bytes)}</span></span>
        </div>
      ) : (
        <div className="muted">nothing running</div>
      )}
      {procs.length > 0 && (
        <div className="proc-list" ref={list}>
          <div className="proc-row proc-head"><span>name</span><span className="num">cpu</span><span className="num">mem</span><span /></div>
          {rows.map((p) => (
            <div key={p.pid} data-flip={p.pid} className="proc-row" title={`${p.pid}  ${p.cmd}`}>
              <span className="proc-name">{p.name}{p.ownership === "observed" ? <span className="muted"> (observed)</span> : null}</span>
              <span className="num">{p.cpu_percent.toFixed(0)}%</span>
              <span className="num">{formatBytes(p.rss_bytes)}</span>
              {p.ownership === "owned" && p.depth > 0 ? <button className="link" title="Kill this process and its children" onClick={() => kill(p.pid)}>kill</button> : <span />}
            </div>
          ))}
        </div>
      )}
    </InspectorSection>
  );
}

export function ago(ms: number): string {
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
    const load = () => rpcParsed("session_list", z.array(agentSessionSchema), { worktree_id: w.id, limit: 8 }).then(setItems).catch(() => setItems([]));
    load();
    const t = window.setInterval(load, 30_000);
    return () => window.clearInterval(t);
  }, [w.id, w.exists, live.join(",")]);
  const resumable = (items ?? []).filter((s) => !live.includes(s.id));
  return (
    <InspectorSection id="sessions" control={items && items.length > 0 ? <span className="right">{items.length}</span> : undefined}>
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
    </InspectorSection>
  );
}

export type FileView = "recent" | "tree";

function FilesSection({ w }: { w: Worktree }) {
  const [view, setView] = useState<FileView>("recent");
  return (
    <InspectorSection id="files" className="side-files" control={<button className="link" title={view === "recent" ? "Newest changes first. Click to show the tree." : "The folder tree. Click to show the newest changes."} onClick={() => setView(view === "recent" ? "tree" : "recent")}>{view}</button>}>
      {view === "recent" ? <RecentFiles w={w} /> : <FileTree w={w} />}
    </InspectorSection>
  );
}

const openInEditor = (w: Worktree, rel: string) => rpc("open_external", { worktree_id: w.id, rel_path: rel, target: "editor" }).catch(failQuietly("open_external"));

function RecentFiles({ w }: { w: Worktree }) {
  const [files, setFiles] = useState<FsEntry[] | null>(null);
  useEffect(() => {
    setFiles(null);
    if (!w.exists) return;
    const load = () => rpcParsed("fs_recent", z.array(fsEntrySchema), { worktree_id: w.id, limit: 50 }).then(setFiles).catch(failQuietly("fs_recent"));
    load();
    const t = window.setInterval(load, 10_000);
    return () => window.clearInterval(t);
  }, [w.id, w.exists]);
  return (
    <div className="file-tree">
      {files === null && w.exists && <SkeletonRows count={3} className="compact" label="looking for files" />}
      {files?.length === 0 && <div className="muted">no files</div>}
      {files?.map((e) => (
        <Tooltip key={e.rel_path} content={<span className="mono">{e.rel_path}</span>} side="left">
          <div className="file-row" onContextMenu={(ev) => openMenu(ev, fileMenu(w, e.rel_path))} onDoubleClick={() => openInEditor(w, e.rel_path)}>
            <File className="icon" />
            <span className="file-name">{e.name}</span>
            <span className="file-age">{ago(e.modified_ms)}</span>
          </div>
        </Tooltip>
      ))}
    </div>
  );
}

function FileTree({ w }: { w: Worktree }) {
  const [selected, setSelected] = useState<string>("");
  const [dirs, setDirs] = useState<Record<string, FsEntry[]>>({});
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set([""]));
  const load = (rel: string) => rpcParsed("fs_list", z.array(fsEntrySchema), { worktree_id: w.id, rel_path: rel }).then((e) => setDirs((d) => ({ ...d, [rel]: e }))).catch(failQuietly("fs_list"));
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
  const render = (rel: string, depth: number): React.ReactNode =>
    (dirs[rel] ?? []).map((e) => (
      <div key={e.rel_path}>
        <div className={`file-row${selected === e.rel_path ? " file-selected" : ""}`} style={{ paddingLeft: 8 + depth * 12 }} onClick={() => { setSelected(e.rel_path); if (e.is_dir) toggle(e.rel_path); }} onContextMenu={(ev) => { setSelected(e.rel_path); openMenu(ev, fileMenu(w, e.rel_path)); }} onDoubleClick={() => !e.is_dir && openInEditor(w, e.rel_path)}>
          {e.is_dir ? (openDirs.has(e.rel_path) ? <ChevronDown className="icon" /> : <ChevronRight className="icon" />) : <File className="icon" />}
          <span className="file-name">{e.name}</span>
        </div>
        {e.is_dir && openDirs.has(e.rel_path) && render(e.rel_path, depth + 1)}
      </div>
    ));
  return (
    <div className="file-tree">
      <div className={`file-row${selected === "" ? " file-selected" : ""}`} onClick={() => setSelected("")} onContextMenu={(ev) => { setSelected(""); openMenu(ev, fileMenu(w, "")); }}><Folder className="icon" /> {w.name}/</div>
      {render("", 1)}
    </div>
  );
}

export type { Id };
