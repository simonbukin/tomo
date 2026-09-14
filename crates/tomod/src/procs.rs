use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tomo_proto::{AgentKind, Id, Ownership, ProcessInfo, WorktreeResources};

#[derive(Debug, Clone)]
pub struct ProcRow {
    pub pid: u32,
    pub ppid: Option<u32>,
    pub name: String,
    /// Refreshed on every poll for pane shells only; `name` is fixed at first sight,
    /// so a shell that exec'd its command keeps the shell's name.
    pub exe: Option<PathBuf>,
    pub cmd: String,
    pub cwd: Option<PathBuf>,
    pub cpu_percent: f32,
    pub rss_bytes: u64,
    pub start_time_s: u64,
}

pub struct Root {
    pub pid: u32,
    pub pane_id: Id,
    pub worktree_id: Id,
}

pub struct ProcMonitor {
    sys: System,
}

impl ProcMonitor {
    pub fn new() -> Self {
        ProcMonitor { sys: System::new() }
    }

    /// Command lines are fetched once per process. Working directories are
    /// fetched once and re-read on every poll only for the pane shells (`roots`);
    /// `full` re-reads every cwd so strangers that enter or leave a worktree
    /// are noticed. Callers pass `full` on every tenth poll.
    pub fn refresh(&mut self, roots: &[u32], full: bool) -> Vec<ProcRow> {
        let cheap = ProcessRefreshKind::nothing()
            .with_cpu()
            .with_memory()
            .with_cwd(if full { UpdateKind::Always } else { UpdateKind::OnlyIfNotSet })
            .with_cmd(UpdateKind::OnlyIfNotSet);
        self.sys.refresh_processes_specifics(ProcessesToUpdate::All, true, cheap);
        if !roots.is_empty() {
            let pids: Vec<sysinfo::Pid> = roots.iter().map(|p| sysinfo::Pid::from_u32(*p)).collect();
            self.sys.refresh_processes_specifics(ProcessesToUpdate::Some(&pids), false, ProcessRefreshKind::nothing().with_cwd(UpdateKind::Always).with_exe(UpdateKind::Always));
        }
        self.sys
            .processes()
            .values()
            .map(|p| ProcRow {
                pid: p.pid().as_u32(),
                ppid: p.parent().map(|x| x.as_u32()),
                name: p.name().to_string_lossy().into_owned(),
                exe: p.exe().map(Path::to_path_buf),
                cmd: p.cmd().iter().map(|c| c.to_string_lossy()).collect::<Vec<_>>().join(" "),
                cwd: p.cwd().map(Path::to_path_buf),
                cpu_percent: p.cpu_usage(),
                rss_bytes: p.memory(),
                start_time_s: p.start_time(),
            })
            .collect()
    }
}

/// The program a process runs now: the exe basename when refreshed, else the first-seen name.
pub fn program_name(row: &ProcRow) -> String {
    row.exe.as_deref().and_then(Path::file_name).map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| row.name.clone())
}

pub fn children_index(rows: &[ProcRow]) -> HashMap<u32, Vec<u32>> {
    rows.iter().filter_map(|r| r.ppid.map(|pp| (pp, r.pid))).fold(HashMap::new(), |mut m, (pp, pid)| {
        m.entry(pp).or_default().push(pid);
        m
    })
}

pub fn descendants(rows: &[ProcRow], root: u32) -> Vec<u32> {
    let index = children_index(rows);
    let mut out = Vec::new();
    let mut queue = VecDeque::from([root]);
    let mut seen = HashSet::new();
    while let Some(pid) = queue.pop_front() {
        if !seen.insert(pid) {
            continue;
        }
        if pid != root {
            out.push(pid);
        }
        if let Some(kids) = index.get(&pid) {
            queue.extend(kids.iter().copied());
        }
    }
    out
}

/// Owned: descends from a pane root. Observed: cwd lies inside a known worktree.
pub fn classify(rows: &[ProcRow], roots: &[Root], worktree_paths: &[(Id, PathBuf)]) -> Vec<ProcessInfo> {
    let index = children_index(rows);
    let mut owned: HashMap<u32, (Id, Id, u32)> = HashMap::new();
    for root in roots {
        let mut queue = VecDeque::from([(root.pid, 0u32)]);
        while let Some((pid, depth)) = queue.pop_front() {
            if owned.contains_key(&pid) {
                continue;
            }
            owned.insert(pid, (root.pane_id.clone(), root.worktree_id.clone(), depth));
            if let Some(kids) = index.get(&pid) {
                queue.extend(kids.iter().map(|k| (*k, depth + 1)));
            }
        }
    }
    let mut sorted_paths: Vec<&(Id, PathBuf)> = worktree_paths.iter().collect();
    sorted_paths.sort_by_key(|(_, p)| std::cmp::Reverse(p.as_os_str().len()));
    let observe = |cwd: &Path| sorted_paths.iter().find(|(_, p)| cwd.starts_with(p)).map(|(id, _)| id.clone());

    let mut out: Vec<ProcessInfo> = Vec::new();
    for row in rows {
        let (worktree_id, pane_id, ownership, depth) = match owned.get(&row.pid) {
            Some((pane, wt, depth)) => (Some(wt.clone()), Some(pane.clone()), Ownership::Owned, *depth),
            None => match row.cwd.as_deref().and_then(observe) {
                Some(wt) if row.pid != std::process::id() => (Some(wt), None, Ownership::Observed, 0),
                _ => continue,
            },
        };
        out.push(ProcessInfo {
            pid: row.pid,
            ppid: row.ppid,
            name: row.name.clone(),
            cmd: row.cmd.clone(),
            cwd: row.cwd.clone(),
            cpu_percent: row.cpu_percent,
            rss_bytes: row.rss_bytes,
            start_time_s: row.start_time_s,
            worktree_id,
            pane_id,
            ownership,
            depth,
        });
    }
    out.sort_by(|a, b| (a.ownership as u8, a.depth, a.pid).cmp(&(b.ownership as u8, b.depth, b.pid)));
    out
}

pub fn aggregate(infos: &[ProcessInfo]) -> Vec<WorktreeResources> {
    let mut by_wt: HashMap<Id, WorktreeResources> = HashMap::new();
    for info in infos {
        let Some(wt) = &info.worktree_id else { continue };
        let entry = by_wt.entry(wt.clone()).or_insert_with(|| WorktreeResources { worktree_id: wt.clone(), ..Default::default() });
        entry.cpu_percent += info.cpu_percent;
        entry.rss_bytes += info.rss_bytes;
        entry.process_count += 1;
    }
    let mut out: Vec<_> = by_wt.into_values().collect();
    out.sort_by(|a, b| b.rss_bytes.cmp(&a.rss_bytes));
    out
}

pub fn detect_agent(name: &str, cmd: &str) -> Option<AgentKind> {
    let base = name.rsplit('/').next().unwrap_or(name);
    let first = cmd.split_whitespace().next().unwrap_or("");
    let first_base = first.rsplit('/').next().unwrap_or(first);
    if base == "claude" || first_base == "claude" {
        return Some(AgentKind::Claude);
    }
    if base.starts_with("codex") || first_base.starts_with("codex") {
        return Some(AgentKind::Codex);
    }
    if base == "pi" || first_base == "pi" || cmd.contains("pi-coding-agent") {
        return Some(AgentKind::Pi);
    }
    None
}

pub fn kill_tree(rows: &[ProcRow], root: u32) {
    let mut pids = descendants(rows, root);
    pids.push(root);
    for pid in pids {
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pid: u32, ppid: u32, name: &str, cwd: &str, rss: u64) -> ProcRow {
        ProcRow { pid, ppid: Some(ppid), name: name.into(), exe: None, cmd: name.into(), cwd: Some(PathBuf::from(cwd)), cpu_percent: 1.0, rss_bytes: rss, start_time_s: 0 }
    }

    #[test]
    fn classifies_owned_descendants_and_observed_by_cwd() {
        let rows = vec![
            row(10, 1, "zsh", "/wt/a", 10),
            row(11, 10, "claude", "/wt/a", 100),
            row(12, 11, "node", "/wt/a", 50),
            row(13, 12, "chromium", "/tmp", 900),
            row(20, 1, "vim", "/wt/a/src", 5),
            row(30, 1, "cargo", "/elsewhere", 5),
        ];
        let roots = vec![Root { pid: 10, pane_id: "p1".into(), worktree_id: "wa".into() }];
        let paths = vec![("wa".to_string(), PathBuf::from("/wt/a"))];
        let infos = classify(&rows, &roots, &paths);
        let find = |pid| infos.iter().find(|i| i.pid == pid).unwrap();
        assert_eq!(find(13).ownership, Ownership::Owned);
        assert_eq!(find(13).depth, 3);
        assert_eq!(find(20).ownership, Ownership::Observed);
        assert!(infos.iter().all(|i| i.pid != 30));
        let agg = aggregate(&infos);
        assert_eq!(agg[0].rss_bytes, 1065);
        assert_eq!(agg[0].process_count, 5);
    }

    #[test]
    fn detects_agents_by_name_or_command() {
        assert_eq!(detect_agent("claude", ""), Some(AgentKind::Claude));
        assert_eq!(detect_agent("codex-aarch64-apple-darwin", ""), Some(AgentKind::Codex));
        assert_eq!(detect_agent("node", "node /x/pi-coding-agent/dist/cli.js"), Some(AgentKind::Pi));
        assert_eq!(detect_agent("zsh", "-zsh"), None);
    }

    fn row_at(pid: u32, ppid: u32, name: &str, cwd: Option<&str>, rss: u64) -> ProcRow {
        ProcRow { pid, ppid: Some(ppid), name: name.into(), exe: None, cmd: name.into(), cwd: cwd.map(PathBuf::from), cpu_percent: 0.5, rss_bytes: rss, start_time_s: 0 }
    }

    #[test]
    fn torture_deep_tree_and_reparented_child() {
        let rows = vec![
            row_at(10, 1, "zsh", Some("/wt/a"), 1),
            row_at(11, 10, "node", Some("/wt/a"), 10),
            row_at(12, 11, "playwright", Some("/wt/a"), 20),
            row_at(13, 12, "chromium", Some("/tmp"), 300),
            row_at(14, 12, "chromium", Some("/tmp"), 300),
            row_at(15, 1, "chromium-daemonized", Some("/wt/a"), 50),
            row_at(16, 1, "unrelated", Some("/wt/a/sub"), 5),
            row_at(17, 1, "elsewhere", Some("/other"), 5),
        ];
        let roots = vec![Root { pid: 10, pane_id: "p".into(), worktree_id: "wa".into() }];
        let paths = vec![("wa".to_string(), PathBuf::from("/wt/a"))];
        let infos = classify(&rows, &roots, &paths);
        let by = |pid: u32| infos.iter().find(|i| i.pid == pid);
        assert_eq!(by(14).unwrap().depth, 3);
        assert_eq!(by(14).unwrap().ownership, Ownership::Owned);
        assert_eq!(by(15).unwrap().ownership, Ownership::Observed, "reparented child is never owned");
        assert_eq!(by(16).unwrap().ownership, Ownership::Observed);
        assert!(by(17).is_none());
        let ids: Vec<u32> = infos.iter().map(|i| i.pid).collect();
        let unique: std::collections::HashSet<u32> = ids.iter().copied().collect();
        assert_eq!(ids.len(), unique.len(), "no pid twice");
        let agg = aggregate(&infos);
        assert_eq!(agg[0].rss_bytes, 1 + 10 + 20 + 300 + 300 + 50 + 5);
        assert_eq!(agg[0].process_count, 7);
    }

    #[test]
    fn torture_cwd_moves_change_only_observed_status() {
        let paths = vec![("wa".to_string(), PathBuf::from("/wt/a"))];
        let inside = vec![row_at(20, 1, "stranger", Some("/wt/a"), 1)];
        assert_eq!(classify(&inside, &[], &paths)[0].ownership, Ownership::Observed);
        let outside = vec![row_at(20, 1, "stranger", Some("/"), 1)];
        assert!(classify(&outside, &[], &paths).is_empty(), "leaving the worktree drops the observation");
        let roots = vec![Root { pid: 30, pane_id: "p".into(), worktree_id: "wa".into() }];
        let owned_elsewhere = vec![row_at(30, 1, "zsh", Some("/wt/a"), 1), row_at(31, 30, "child", Some("/"), 1)];
        let infos = classify(&owned_elsewhere, &roots, &paths);
        assert_eq!(infos.iter().find(|i| i.pid == 31).unwrap().ownership, Ownership::Owned, "owned stays owned when it cds away");
        assert!(descendants(&owned_elsewhere, 30).contains(&31));
    }
}
