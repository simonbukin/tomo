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
        let prio = w.metadata.priority.map(|p| format!(" P{p}")).unwrap_or_default();
        let tags = if w.metadata.tags.is_empty() { String::new() } else { format!(" #{}", w.metadata.tags.join(" #")) };
        let branch = if w.detached { "detached".to_string() } else { w.branch.clone().unwrap_or_default() };
        let dirty = w.git.as_ref().map_or("", |g| if g.dirty { " *" } else { "" });
        let missing = if w.archived_at_ms.is_some() { " (archived)" } else if w.exists { "" } else { " (missing)" };
        let project = w.metadata.project.as_deref().map(|p| format!(" [{p}]")).unwrap_or_default();
        println!("{}  {} / {}{}{}{}  {}{}{}", w.id, repo, w.name, project, prio, tags, branch, dirty, missing);
        let town = w.town_slug.as_deref().map(|t| format!("  town {t}")).unwrap_or_default();
        println!("    {}{}", w.path.display(), town);
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
    println!("project      {}", m.project.as_deref().unwrap_or("-"));
    println!("priority     {}", m.priority.map(|p| format!("P{p}")).unwrap_or_else(|| "-".into()));
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
    if s.chars().count() <= n { s.to_string() } else { format!("{}…", s.chars().take(n).collect::<String>()) }
}

pub fn towns(towns: &[Town], unlocks: &[TownUnlock], only_unlocked: bool, json: bool) {
    let rows: Vec<(&Town, Option<&TownUnlock>)> = towns
        .iter()
        .map(|t| (t, unlocks.iter().find(|u| u.slug == t.slug)))
        .filter(|(_, u)| !only_unlocked || u.is_some())
        .collect();
    if json {
        let v: Vec<Value> = rows.iter().map(|(t, u)| serde_json::json!({ "town": t, "unlock": u })).collect();
        return emit_json(&v);
    }
    for (t, u) in rows {
        let when = u.map(|u| format!("  unlocked {}", u.unlocked_at_ms)).unwrap_or_default();
        println!("{:<28} {:<16} {:<8} {:<12} {:<9}{}", t.slug, t.name, t.ja, t.pref, t.rarity, when);
    }
}

pub fn attention(items: &[AttentionItem], json: bool) {
    if json {
        return emit_json(&items);
    }
    for i in items {
        let seen = if i.viewed_at_ms.is_some() { "seen" } else { "NEW " };
        println!("{}  {seen}  {:?}  wt {}  pane {}  {}", i.id, i.level, i.worktree_id, i.pane_id.as_deref().unwrap_or("-"), i.message);
    }
}
