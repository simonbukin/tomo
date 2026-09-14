import { useEffect, useState } from "react";
import { rpc } from "./api";
import { setMetadata } from "./actions";
import { formatBytes, notify, useStore } from "./store";
import type { FsEntry, Id, ProcessInfo, Worktree } from "./types";

export function RightSidebar({ worktree }: { worktree: Worktree }) {
  return (
    <aside className="rightbar">
      <MetadataSection w={worktree} />
      <GitSection w={worktree} />
      <ProcessSection w={worktree} />
      <FilesSection w={worktree} />
    </aside>
  );
}

function MetadataSection({ w }: { w: Worktree }) {
  const m = w.metadata;
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
    <section className="side-section">
      <h3>Worktree</h3>
      <div className="kv"><label>name</label><input value={name} placeholder={w.path.split("/").pop()} onChange={(e) => setName(e.target.value)} onBlur={() => commit({ display_name: name.trim() || null })} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} /></div>
      <div className="kv"><label>project</label><input value={project} onChange={(e) => setProject(e.target.value)} onBlur={() => commit({ project: project.trim() || null })} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} /></div>
      <div className="kv"><label>priority</label>
        <select value={m.priority ?? ""} onChange={(e) => commit({ priority: e.target.value ? Number(e.target.value) : null })}>
          <option value="">unset</option><option value="1">P1</option><option value="2">P2</option><option value="3">P3</option><option value="4">P4</option>
        </select>
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
    <section className="side-section">
      <h3>Git <button className="link" onClick={() => rpc("git_summary", { worktree_id: w.id }).catch(() => {})}>refresh</button></h3>
      <div className="kv"><label>branch</label><span className="mono">{w.detached ? `detached ${w.head.slice(0, 7)}` : w.branch ?? "—"}</span></div>
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
  const kill = (pid: number) => rpc("process_kill_tree", { pid }).catch((e) => notify("error", (e as Error).message));
  return (
    <section className="side-section">
      <h3>Processes <button className="link" onClick={() => setOpen(!open)}>{open ? "hide" : "show"}</button></h3>
      {res ? (
        <div className="kv"><label>total</label><span>{res.process_count} proc · {res.cpu_percent.toFixed(0)}% cpu · {formatBytes(res.rss_bytes)}</span></div>
      ) : (
        <div className="muted">nothing running</div>
      )}
      {open && (
        <div className="proc-list">
          {[...procs].sort((a, b) => b.rss_bytes - a.rss_bytes).slice(0, 25).map((p) => (
            <div key={p.pid} className="proc-row" title={p.cmd}>
              <span className="mono muted">{p.pid}</span>
              <span className="proc-name" style={{ paddingLeft: p.depth * 8 }}>{p.name}{p.ownership === "observed" ? <span className="muted"> (observed)</span> : null}</span>
              <span className="mono">{formatBytes(p.rss_bytes)}</span>
              {p.ownership === "owned" && p.depth > 0 && <button className="link" title="Kill this process and its children" onClick={() => kill(p.pid)}>kill</button>}
            </div>
          ))}
        </div>
      )}
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
  const act = (target: "finder" | "editor") => rpc("open_external", { worktree_id: w.id, rel_path: selected, target }).catch((e) => notify("error", (e as Error).message));
  const copy = () => navigator.clipboard.writeText(selected ? `${w.path}/${selected}` : w.path).then(() => notify("info", "Path copied"));
  const render = (rel: string, depth: number): React.ReactNode =>
    (dirs[rel] ?? []).map((e) => (
      <div key={e.rel_path}>
        <div className={`file-row${selected === e.rel_path ? " file-selected" : ""}`} style={{ paddingLeft: 8 + depth * 12 }} onClick={() => { setSelected(e.rel_path); if (e.is_dir) toggle(e.rel_path); }} onDoubleClick={() => !e.is_dir && rpc("open_external", { worktree_id: w.id, rel_path: e.rel_path, target: "editor" }).catch(() => {})}>
          <span className="muted">{e.is_dir ? (openDirs.has(e.rel_path) ? "▾" : "▸") : " "}</span> {e.name}
        </div>
        {e.is_dir && openDirs.has(e.rel_path) && render(e.rel_path, depth + 1)}
      </div>
    ));
  return (
    <section className="side-section side-files">
      <h3>Files</h3>
      <div className="file-actions">
        <button className="link" onClick={() => act("finder")}>reveal</button>
        <button className="link" onClick={copy}>copy path</button>
        <button className="link" onClick={() => act("editor")}>open in editor</button>
      </div>
      <div className="file-tree">
        <div className={`file-row${selected === "" ? " file-selected" : ""}`} onClick={() => setSelected("")}>{w.name}/</div>
        {render("", 1)}
      </div>
    </section>
  );
}

export type { Id };
