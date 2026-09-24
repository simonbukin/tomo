//! Composition root for daemon addons: the static list, the seams each addon joins, the tables it owns, and its background tasks.
//! Core never imports this module. Only `main.rs` and `dispatch.rs` do.

use crate::daemon::{Daemon, Inner, Seams};
use crate::store::Store;
use std::sync::Arc;

/// The in-memory state of the addons of one daemon. Each addon owns one field. It lives in `Inner`, so the Core lock guards it.
#[derive(Default)]
pub struct State {}

#[allow(dead_code, reason = "addon seam; the base ships no addons")]
const NOT_FILLED: &str = "the composition root fills Inner.addons with addons::State";

#[allow(dead_code, reason = "addon seam; the base ships no addons")]
pub fn state(inner: &Inner) -> &State {
    inner.addons.downcast_ref().expect(NOT_FILLED)
}

#[allow(dead_code, reason = "addon seam; the base ships no addons")]
pub fn state_mut(inner: &mut Inner) -> &mut State {
    inner.addons.downcast_mut().expect(NOT_FILLED)
}

pub fn seams() -> Seams {
    Seams { worktree_namer: None, worktree_created: vec![], worktree_rebound: vec![], worktree_files: vec![], pane_exited: vec![], process_polled: vec![] }
}

pub fn migrate(_store: &Store) -> anyhow::Result<()> {
    Ok(())
}

/// Starts the background task of each addon that has one. The addon doc gives the reason for each task.
pub fn start(_daemon: &Arc<Daemon>) {}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

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
