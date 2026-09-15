//! Composition root for daemon addons: the static list, the seams each addon joins, the tables it owns, and its background tasks.
//! Core never imports this module. Only `main.rs` and `dispatch.rs` do.

pub mod actions;
pub mod agentation;
pub mod github;
pub mod towns;
pub mod usage;

use crate::daemon::{Daemon, Seams};
use crate::store::Store;
use std::sync::Arc;

pub fn seams() -> Seams {
    Seams {
        worktree_namer: Some(towns::name_worktree),
        worktree_created: vec![towns::unlock],
        worktree_rebound: vec![towns::rebind],
        worktree_files: vec![actions::FILE],
        pane_exited: vec![actions::exited],
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
    use std::path::{Path, PathBuf};

    const COMPOSITION_ROOTS: [&str; 3] = ["tomod/src/main.rs", "tomod/src/dispatch.rs", "tomo-proto/src/lib.rs"];
    const MODULE_NOUNS: [&str; 2] = ["addons::", "mod addons"];
    const OWNED_NOUNS: [(&str, &[&str]); 5] = [
        ("towns", &["town"]),
        ("github", &["github", "pullrequest", "prstatus", "pr_status", "prchanged", "pr_changed", "review_decision", "checks_failed", "mergeable"]),
        ("usage", &["mod usage", "crate::usage", ".usage", "usage:", "usagesnapshot", "usagebucket", "usage_get", "usageget", "usage_changed", "usagechanged", "weekly", "5-hour", "allowance"]),
        (
            "actions",
            &["actiondef", "actionset", "actionrunresult", "actionmode", "actionshow", "actionactivity", "tomo.toml", "features::actions", "inner.actions", "run_action", "stop_action", "reload_actions", "action_def"],
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
