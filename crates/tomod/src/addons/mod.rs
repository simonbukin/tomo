//! Composition root for daemon addons: the static list, the seams each addon joins, the tables it owns, and its background tasks.
//! Core never imports this module. Only `main.rs` and `dispatch.rs` do.

pub mod actions;
pub mod agentation;
pub mod github;
pub mod runtime;
pub mod towns;
pub mod usage;

use crate::daemon::{Daemon, Inner, Seams};
use crate::store::Store;
use std::sync::Arc;

/// The in-memory state of the addons of one daemon. Each addon owns one field. It lives in `Inner`, so the Core lock guards it.
#[derive(Default)]
pub struct State {
    pub actions: actions::Sets,
    pub github: github::Cache,
    pub runtime: runtime::Endpoints,
    pub usage: usage::Last,
}

const NOT_FILLED: &str = "the composition root fills Inner.addons with addons::State";

pub fn state(inner: &Inner) -> &State {
    inner.addons.downcast_ref().expect(NOT_FILLED)
}

pub fn state_mut(inner: &mut Inner) -> &mut State {
    inner.addons.downcast_mut().expect(NOT_FILLED)
}

pub fn seams() -> Seams {
    Seams {
        worktree_namer: Some(towns::name_worktree),
        worktree_created: vec![towns::unlock],
        worktree_rebound: vec![towns::rebind],
        worktree_files: vec![actions::FILE],
        pane_exited: vec![actions::exited],
        process_polled: vec![runtime::scan],
        hook_events: [actions::HOOK_EVENTS, runtime::HOOK_EVENTS, agentation::HOOK_EVENTS].concat(),
    }
}

pub fn migrate(store: &Store) -> anyhow::Result<()> {
    towns::migrate(store)
}

/// Starts the background task of each addon that has one. The addon doc gives the reason for each task.
pub fn start(daemon: &Arc<Daemon>) {
    tokio::spawn(usage::run(daemon.clone()));
}

#[cfg(test)]
mod tests {
    use crate::daemon::Daemon;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    const COMPOSITION_ROOTS: [&str; 3] = ["tomod/src/main.rs", "tomod/src/dispatch.rs", "tomo-proto/src/lib.rs"];
    const MODULE_NOUNS: [&str; 2] = ["addons::", "mod addons"];
    const OWNED_NOUNS: [(&str, &[&str]); 6] = [
        (
            "runtime",
            &[
                "runtimeendpoint",
                "runtimeprotocol",
                "runtimeactivity",
                "runtime_list",
                "runtimelist",
                "endpoints_changed",
                "endpointschanged",
                "scan_endpoints",
                "endpoint_gone",
                "endpoints_at",
                "endpoint_repeat",
                "inner.endpoints",
                "lsof",
            ],
        ),
        ("towns", &["town"]),
        ("github", &["github", "pullrequest", "prstatus", "pr_status", "prchanged", "pr_changed", "review_decision", "checks_failed", "mergeable"]),
        (
            "usage",
            &[
                "mod usage",
                "crate::usage",
                ".usage",
                "usage:",
                "usagesnapshot",
                "usagebucket",
                "usage_get",
                "usageget",
                "usage_changed",
                "usagechanged",
                "weekly",
                "5-hour",
                "allowance",
            ],
        ),
        (
            "actions",
            &[
                "actiondef",
                "actionset",
                "actionrunresult",
                "actionmode",
                "actionshow",
                "actionactivity",
                "tomo.toml",
                "features::actions",
                "inner.actions",
                "run_action",
                "stop_action",
                "reload_actions",
                "action_def",
            ],
        ),
        ("agentation", &["agentation", "evidencebundle", "evidence_text", "evidence_title", "annotationssend", "annotations_send", "annotation.sent"]),
    ];

    fn core_nouns() -> impl Iterator<Item = &'static &'static str> {
        MODULE_NOUNS.iter().chain(OWNED_NOUNS.iter().flat_map(|(_, nouns)| nouns.iter()))
    }

    fn owner(rel: &str) -> Option<&'static str> {
        OWNED_NOUNS.iter().map(|(name, _)| *name).find(|name| rel.contains(&format!("/addons/{name}/")) || rel.ends_with(&format!("/addons/{name}.rs")))
    }

    fn rust_files(dir: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .flat_map(|p| if p.is_dir() { rust_files(&p) } else { vec![p] })
            .filter(|p| p.extension().is_some_and(|x| x == "rs"))
            .collect()
    }

    const CORE_ACTIVITY_FILES: [&str; 4] = ["tomod/src/activity.rs", "tomod/src/store.rs", "tomod/src/events.rs", "tomo-proto/src/activity.rs"];
    const ADDON_ACTIVITY_NOUNS: [&str; 12] = [
        "actionactivity",
        "runtimeactivity",
        "githubactivity",
        "agentationactivity",
        "action_started",
        "action_stopped",
        "action_completed",
        "action_crashed",
        "endpoint_discovered",
        "endpoint_repeat",
        "annotations_sent",
        "pr_merged",
    ];

    #[test]
    fn core_activity_code_does_not_name_addon_kinds() {
        let crates = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
        let hits: Vec<String> = CORE_ACTIVITY_FILES
            .iter()
            .flat_map(|rel| {
                let text = std::fs::read_to_string(crates.join(rel)).unwrap();
                let code = text.split("#[cfg(test)]").next().unwrap_or_default().to_lowercase();
                code.lines()
                    .enumerate()
                    .filter_map(|(i, line)| ADDON_ACTIVITY_NOUNS.iter().find(|noun| line.contains(**noun)).map(|noun| format!("{rel}:{}: {noun}", i + 1)))
                    .collect::<Vec<_>>()
            })
            .collect();
        assert!(hits.is_empty(), "core activity code names an addon kind:\n{}", hits.join("\n"));
    }

    async fn subscribe(daemon: &Arc<Daemon>) -> tomo_proto::Snapshot {
        serde_json::from_value(crate::dispatch::handle(daemon, 0, tomo_proto::Call::Subscribe).await.unwrap()).unwrap()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn two_daemons_in_one_process_keep_their_own_addon_state() {
        use tomo_proto::*;
        let dir = PathBuf::from(format!("/tmp/tomo-addons-state-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let git = |args: &[&str]| {
            assert!(std::process::Command::new("git")
                .args(["-c", "user.email=t@t", "-c", "user.name=t"])
                .args(args)
                .current_dir(&repo)
                .output()
                .unwrap()
                .status
                .success())
        };
        git(&["init", "-q"]);
        git(&["commit", "-q", "--allow-empty", "-m", "init"]);
        std::fs::write(repo.join(".tomo.toml"), "[[actions]]\nid = \"serve\"\ncommand = \"true\"\n").unwrap();
        let [a, b] = ["a", "b"].map(|name| {
            let daemon = Daemon::new(crate::config::Paths::new(dir.join(name)), super::seams(), Box::new(super::State::default())).unwrap();
            super::migrate(&daemon.lock().store).unwrap();
            daemon
        });

        crate::dispatch::handle(&a, 0, Call::RepoAdd { path: repo.clone() }).await.unwrap();
        let worktree_id = a.lock().worktrees.keys().next().unwrap().clone();
        let usage = UsageSnapshot { provider: AgentKind::Claude, available: true, reason: None, buckets: vec![], fetched_at_ms: now_ms() };
        super::usage::remember(&mut a.lock(), vec![usage]);
        let pr = PullRequest {
            number: 7,
            title: "t".into(),
            url: "u".into(),
            state: "open".into(),
            draft: false,
            review_decision: None,
            mergeable: None,
            checks_passed: 0,
            checks_failed: 0,
            checks_pending: 0,
            fetched_at_ms: now_ms(),
        };
        super::github::remember(&mut a.lock(), worktree_id.clone(), PrStatusResult { available: true, reason: None, pr: Some(pr) });
        let endpoint = RuntimeEndpoint {
            id: "1:3000".into(),
            worktree_id: worktree_id.clone(),
            pane_id: None,
            action_id: None,
            pid: 1,
            process: "node".into(),
            protocol: RuntimeProtocol::Tcp,
            status: None,
            probing: false,
            host: "localhost".into(),
            port: 3000,
            label: None,
            discovered_at_ms: now_ms(),
            source: None,
        };
        super::runtime::remember(&mut a.lock(), vec![endpoint], now_ms());

        let (seen_by_a, seen_by_b) = (subscribe(&a).await, subscribe(&b).await);
        assert_eq!(seen_by_b.usage.len(), 0, "usage leaked into the second daemon");
        assert_eq!(seen_by_b.actions.len(), 0, "action sets leaked into the second daemon");
        assert_eq!(seen_by_b.endpoints.len(), 0, "endpoints leaked into the second daemon");
        assert!(super::github::known_pr(&b.lock(), &worktree_id, &[]).is_none(), "the pull request cache leaked into the second daemon");
        assert_eq!((seen_by_a.usage.len(), seen_by_a.actions.len(), seen_by_a.endpoints.len()), (1, 1, 1));
        assert!(super::github::known_pr(&a.lock(), &worktree_id, &[]).is_some());
        assert_eq!(a.lock().worktrees[&worktree_id].metadata.tags, vec!["review"], "an open pull request sets its GitHub tag");
        assert!(a.lock().hook_queue.iter().any(|e| e.event == "worktree.tags_changed"));
        assert!(b.lock().worktrees.values().all(|w| w.metadata.tags.is_empty()));
        a.shutdown();
        b.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn core_does_not_import_addons() {
        let crates = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
        let hits: Vec<String> = ["tomod/src", "tomo-proto/src"]
            .iter()
            .flat_map(|dir| rust_files(&crates.join(dir)))
            .map(|p| p.strip_prefix(&crates).unwrap().to_string_lossy().into_owned())
            .filter(|rel| !rel.contains("/addons/") && !COMPOSITION_ROOTS.contains(&rel.as_str()))
            .flat_map(|rel| {
                let text = std::fs::read_to_string(crates.join(&rel)).unwrap_or_default();
                text.lines()
                    .enumerate()
                    .filter_map(|(i, line)| core_nouns().find(|noun| line.to_lowercase().contains(**noun)).map(|noun| format!("{rel}:{}: {noun}", i + 1)))
                    .collect::<Vec<_>>()
            })
            .collect();
        assert!(hits.is_empty(), "core names an addon:\n{}", hits.join("\n"));
    }

    #[test]
    fn addon_modules_keep_no_mutable_static() {
        let addons = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/addons");
        let mutable = ["Mutex", "RwLock", "Atomic", "Cell", "static mut"];
        let hits: Vec<String> = rust_files(&addons)
            .into_iter()
            .flat_map(|path| {
                let text = std::fs::read_to_string(&path).unwrap_or_default();
                text.lines()
                    .enumerate()
                    .map(|(i, line)| (i, line.trim_start().trim_start_matches("pub ").trim_start_matches("pub(crate) ")))
                    .filter(|(_, line)| line.starts_with("static ") && mutable.iter().any(|m| line.contains(m)))
                    .map(|(i, line)| format!("{}:{}: {line}", path.display(), i + 1))
                    .collect::<Vec<_>>()
            })
            .collect();
        assert!(hits.is_empty(), "an addon keeps mutable state in a static; put it in addons::State:\n{}", hits.join("\n"));
    }

    #[test]
    fn an_addon_does_not_name_another_addon() {
        let crates = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
        let hits: Vec<String> = ["tomod/src/addons", "tomo-proto/src/addons"]
            .iter()
            .flat_map(|dir| rust_files(&crates.join(dir)))
            .map(|p| p.strip_prefix(&crates).unwrap().to_string_lossy().into_owned())
            .filter(|rel| rel != "tomod/src/addons/mod.rs")
            .flat_map(|rel| {
                let own = owner(&rel);
                let text = std::fs::read_to_string(crates.join(&rel)).unwrap_or_default().to_lowercase();
                let (rel, text) = (&rel, &text);
                OWNED_NOUNS
                    .iter()
                    .filter(|(name, _)| Some(*name) != own)
                    .flat_map(|(name, nouns)| nouns.iter().filter(|noun| text.contains(**noun)).map(move |noun| format!("{rel} names {name}: {noun}")))
                    .collect::<Vec<_>>()
            })
            .collect();
        assert!(hits.is_empty(), "an addon names another addon:\n{}", hits.join("\n"));
    }
}
