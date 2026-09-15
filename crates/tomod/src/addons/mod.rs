//! Composition root for daemon addons: the static list, the seams each addon joins, and the tables it owns.
//! Core never imports this module. Only `main.rs` and `dispatch.rs` do.

pub mod towns;

use crate::daemon::Seams;
use crate::store::Store;

pub fn seams() -> Seams {
    Seams { worktree_namer: Some(towns::name_worktree), worktree_created: vec![towns::unlock], worktree_rebound: vec![towns::rebind] }
}

pub fn migrate(store: &Store) -> anyhow::Result<()> {
    towns::migrate(store)
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    const COMPOSITION_ROOTS: [&str; 3] = ["tomod/src/main.rs", "tomod/src/dispatch.rs", "tomo-proto/src/lib.rs"];
    const ADDON_NOUNS: [&str; 3] = ["addons::", "mod addons", "town"];

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
                    .filter_map(|(i, line)| ADDON_NOUNS.iter().find(|noun| line.to_lowercase().contains(**noun)).map(|noun| format!("{rel}:{}: {noun}", i + 1)))
                    .collect::<Vec<_>>()
            })
            .collect();
        assert!(hits.is_empty(), "core names an addon:\n{}", hits.join("\n"));
    }
}
