use serde_json::Value;
use tomo_proto::*;

fn emit_json<T: serde::Serialize>(v: &T) {
    println!("{}", serde_json::to_string_pretty(v).unwrap_or_default());
}

pub fn value(v: &Value, json: bool) {
    if json {
        println!("{}", serde_json::to_string_pretty(v).unwrap_or_default());
    } else {
        println!("{v}");
    }
}

fn human_bytes(b: u64) -> String {
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    let b = b as f64;
    if b >= GB {
        format!("{:.1} GB", b / GB)
    } else if b >= MB {
        format!("{:.0} MB", b / MB)
    } else {
        format!("{:.0} KB", b / 1024.0)
    }
}

pub fn status(s: &Status, json: bool) {
    if json {
        return emit_json(s);
    }
    println!("tomod {} pid {} session {}", s.version, s.daemon_pid, s.session_id);
    println!("socket   {}", s.socket_path.display());
    println!("data     {}", s.data_dir.display());
    println!("repos {}  worktrees {}  panes {} ({} live)  agents {}  clients {}", s.repos, s.worktrees, s.panes, s.live_panes, s.agents, s.clients);
    integrations(&s.integrations, false);
}

pub fn integrations(i: &Integrations, json: bool) {
    if json {
        return emit_json(i);
    }
    let mark = |b: bool| if b { "installed" } else { "not installed" };
    println!("hooks    claude {}  codex {}  pi {}", mark(i.claude_hooks), mark(i.codex_hooks), mark(i.pi_extension));
}

pub fn repos(repos: &[Repo], json: bool) {
    if json {
        return emit_json(&repos);
    }
    for r in repos {
        println!("{}  {}  {}{}", r.id, r.name, r.path.display(), if r.exists { "" } else { "  (missing)" });
    }
}

pub fn worktrees(ws: &[Worktree], repos: &[Repo], agents: &[AgentPresence], json: bool) {
    if json {
        return emit_json(&ws);
    }
    for w in ws {
        let repo = repos.iter().find(|r| r.id == w.repo_id).map(|r| r.name.as_str()).unwrap_or("?");
        let tags = if w.metadata.tags.is_empty() { String::new() } else { format!(" #{}", w.metadata.tags.join(" #")) };
        let branch = if w.detached { "detached".to_string() } else { w.branch.clone().unwrap_or_default() };
        let dirty = w.git.as_ref().map_or("", |g| if g.dirty { " *" } else { "" });
        let missing = if w.archived_at_ms.is_some() {
            " (archived)"
        } else if w.exists {
            ""
        } else {
            " (missing)"
        };
        println!("{}  {} / {}{}  {}{}{}", w.id, repo, w.name, tags, branch, dirty, missing);
        println!("    {}", w.path.display());
        for a in agents.iter().filter(|a| a.worktree_id == w.id) {
            println!("    {} {:<7} {:?}", a.state.glyph(), a.kind.label(), a.state);
        }
    }
}

pub fn metadata(m: &WorktreeMetadata, json: bool) {
    if json {
        return emit_json(m);
    }
    println!("display_name {}", m.display_name.as_deref().unwrap_or("-"));
    println!("tags         {}", if m.tags.is_empty() { "-".to_string() } else { m.tags.join(", ") });
}

pub fn panes(panes: &[Pane], json: bool) {
    if json {
        return emit_json(&panes);
    }
    for p in panes {
        let agent = p.agent.as_ref().map(|a| format!("  {} {}", a.state.glyph(), a.kind.label())).unwrap_or_default();
        let state = if p.live { "live" } else { "exited" };
        println!("{}  tab {}  wt {}  {:<8} pid {:<6} {:?}  {}{}", p.id, p.tab_id, p.worktree_id, state, p.pid.unwrap_or(0), p.origin, p.title, agent);
        println!("    {}", p.cwd.display());
    }
}

pub fn pane_result(v: &Value, json: bool) {
    if json {
        return value(v, true);
    }
    if let Some(id) = v["pane"]["id"].as_str() {
        println!("{id}");
    }
}

pub fn agents(agents: &[AgentPresence], json: bool) {
    if json {
        return emit_json(&agents);
    }
    for a in agents {
        println!(
            "{} {:<7} {:<8} pane {}  wt {}  session {}",
            a.state.glyph(),
            a.kind.label(),
            format!("{:?}", a.state).to_lowercase(),
            a.pane_id,
            a.worktree_id,
            a.session_ref.as_deref().unwrap_or("-")
        );
    }
}

pub fn spawn(r: &SpawnResult, json: bool) {
    if json {
        return emit_json(r);
    }
    println!("pane {}  tab {}  worktree {}", r.pane.id, r.tab.id, r.pane.worktree_id);
    if let Some(a) = &r.agent {
        println!("{} {}  session {}", a.state.glyph(), a.kind.label(), a.session_ref.as_deref().unwrap_or("-"));
    }
}

pub fn ps(procs: &[ProcessInfo], ws: &[Worktree], json: bool) {
    if json {
        return emit_json(&procs);
    }
    let mut current: Option<&str> = None;
    for p in procs {
        let wt = p.worktree_id.as_deref().unwrap_or("-");
        if current != Some(wt) {
            current = Some(wt);
            let name = ws.iter().find(|w| w.id == wt).map(|w| w.name.clone()).unwrap_or_else(|| wt.to_string());
            let total: u64 = procs.iter().filter(|q| q.worktree_id.as_deref() == Some(wt)).map(|q| q.rss_bytes).sum();
            println!("{name}  ({})", human_bytes(total));
        }
        let indent = "  ".repeat(p.depth as usize + 1);
        let own = match p.ownership {
            Ownership::Owned => "",
            Ownership::Observed => " (observed)",
            Ownership::Unknown => " (unknown)",
        };
        println!("{indent}{:<7} {:>5.1}% {:>8}  {}{}", p.pid, p.cpu_percent, human_bytes(p.rss_bytes), truncate(&p.cmd, 70), own);
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        format!("{}...", s.chars().take(n.saturating_sub(3)).collect::<String>())
    }
}

pub fn attention(items: &[AttentionItem], json: bool) {
    if json {
        return emit_json(&items);
    }
    for i in items {
        let seen = if i.resolved_at_ms.is_some() {
            "done"
        } else if i.viewed_at_ms.is_some() {
            "seen"
        } else {
            "NEW "
        };
        let kind = format!("{:?}", i.kind).to_lowercase();
        let url = i.url.as_deref().map(|u| format!("  {u}")).unwrap_or_default();
        println!("{}  {seen}  {:<10} {:?}  wt {}  pane {}  {}{url}", i.id, kind, i.level, i.worktree_id, i.pane_id.as_deref().unwrap_or("-"), i.message);
    }
}

pub fn attention_item(item: &AttentionItem, json: bool) {
    if json {
        return emit_json(item);
    }
    attention(std::slice::from_ref(item), false);
}

pub fn activity(list: &[ActivityEvent], json: bool) {
    if json {
        return emit_json(&list);
    }
    if list.is_empty() {
        println!("no activity");
    }
    let offset = local_offset_s();
    for e in list {
        let detail = e.detail.as_deref().map(|d| format!(" · {d}")).unwrap_or_default();
        println!("{}  {}{detail}", clock(e.occurred_at_ms, offset), e.title);
    }
}

fn local_offset_s() -> i64 {
    let out = std::process::Command::new("date").arg("+%z").output().ok();
    let text = out.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
    let (sign, digits) = match text.split_at_checked(1) {
        Some(("-", d)) => (-1, d),
        Some((_, d)) => (1, d),
        None => return 0,
    };
    let hours: i64 = digits.get(..2).and_then(|h| h.parse().ok()).unwrap_or(0);
    let minutes: i64 = digits.get(2..4).and_then(|m| m.parse().ok()).unwrap_or(0);
    sign * (hours * 3600 + minutes * 60)
}

fn clock(at_ms: u64, offset_s: i64) -> String {
    let local = (at_ms / 1000) as i64 + offset_s;
    let of_day = local.rem_euclid(86_400);
    format!("{:02}:{:02}", of_day / 3600, (of_day % 3600) / 60)
}

pub fn integration_status(list: &[IntegrationStatus], json: bool) {
    if json {
        return emit_json(&list);
    }
    for s in list {
        let level = match s.level {
            IntegrationLevel::Full => "✓ full",
            IntegrationLevel::Partial => "⚠ partial",
            IntegrationLevel::ProcessOnly => "⚠ process-only",
            IntegrationLevel::Unavailable => "× unavailable",
        };
        let caps = match (s.lifecycle, s.resume) {
            (true, true) => "lifecycle + resume",
            (false, true) => "resume only",
            (true, false) => "lifecycle only",
            (false, false) => "process heuristic",
        };
        println!("{:<7} {:<16} {}{}", s.kind.label(), level, caps, s.reason.as_deref().map(|r| format!("  ({r})")).unwrap_or_default());
    }
}

pub fn config_issues(issues: &[ConfigIssue], json: bool) {
    if json {
        return emit_json(&issues);
    }
    if issues.is_empty() {
        println!("config ok");
    }
    for i in issues {
        let level = match i.level {
            IssueLevel::Error => "error",
            IssueLevel::Warning => "warning",
        };
        println!("{level:<8} {:<20} {}", i.key, i.message);
    }
}

pub fn hook_runs(runs: &[HookRun], json: bool) {
    if json {
        return emit_json(&runs);
    }
    for r in runs {
        let status = if r.ok { "ok" } else { "FAIL" };
        println!(
            "{status:<5} {:<26} {:>6} ms  exit {:<4} {}",
            r.event,
            r.duration_ms,
            r.exit_code.map(|c| c.to_string()).unwrap_or_else(|| "-".into()),
            r.command
        );
        if !r.ok && !r.output_tail.is_empty() {
            for line in r.output_tail.lines().rev().take(3).collect::<Vec<_>>().into_iter().rev() {
                println!("      {line}");
            }
        }
    }
}

pub fn archive_result(r: &ArchiveResult, json: bool) {
    if json {
        return emit_json(r);
    }
    println!("archived {}", r.worktree_id);
    match &r.checkpoint_commit {
        Some(c) => println!("checkpoint {} tomo: archive checkpoint", &c[..c.len().min(7)]),
        None => println!("checkpoint not needed (clean)"),
    }
    if let Some(b) = &r.branch {
        println!("branch kept: {b}");
    }
}

pub fn sessions(list: &[AgentSession], json: bool) {
    if json {
        return emit_json(&list.to_vec());
    }
    if list.is_empty() {
        println!("no agent sessions rooted here");
    }
    for s in list {
        let age = age(s.updated_at_ms);
        println!("{:<7} {:<38} {:>3} turns  {:<8} {}", s.kind.label().to_lowercase(), s.id, s.turns, age, s.title.as_deref().unwrap_or("-"));
    }
}

fn age(at_ms: u64) -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let secs = now.saturating_sub(at_ms) / 1000;
    match secs {
        s if s < 60 => format!("{s}s ago"),
        s if s < 3600 => format!("{}m ago", s / 60),
        s if s < 86_400 => format!("{}h ago", s / 3600),
        s => format!("{}d ago", s / 86_400),
    }
}

