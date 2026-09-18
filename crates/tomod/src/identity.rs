//! The name a worktree's infrastructure is created under.
//!
//! Every way of isolating a worktree needs one stable name: Compose spends it as
//! `COMPOSE_PROJECT_NAME`, Apple's container as a name prefix, a sandbox profile as an allowed
//! subpath. Tomo mints it; what runs decides how to spend it.

/// The longest a label may be in the name. A project name becomes part of a volume name and of
/// the unix sockets inside it, and macOS stops at 104 bytes for a socket path.
const LABEL_MAX: usize = 16;

/// Lowercase letters, digits and single dashes, starting and ending on a character Compose
/// accepts. An empty result becomes `wt`, so a worktree named only in punctuation still works.
pub fn slug(label: &str) -> String {
    let mut out = String::with_capacity(label.len());
    for ch in label.chars() {
        match ch {
            'a'..='z' | '0'..='9' => out.push(ch),
            'A'..='Z' => out.push(ch.to_ascii_lowercase()),
            _ if out.ends_with('-') || out.is_empty() => {}
            _ => out.push('-'),
        }
    }
    let trimmed = out.trim_matches('-');
    let cut = trimmed.char_indices().nth(LABEL_MAX).map_or(trimmed.len(), |(i, _)| i);
    let short = trimmed[..cut].trim_end_matches('-');
    if short.is_empty() {
        "wt".to_string()
    } else {
        short.to_string()
    }
}

/// Minted once, then kept for ever.
///
/// A rename or a move must not change this name. Containers and volumes are created under it,
/// and nothing else records where they went: recompute it and the old ones are orphaned, holding
/// a database that no longer belongs to anything.
pub fn infra_name(existing: Option<&str>, label: &str, seed: &str) -> String {
    if let Some(name) = existing.map(str::trim).filter(|n| !n.is_empty()) {
        return name.to_string();
    }
    let tail: String = seed.chars().filter(|c| c.is_ascii_alphanumeric()).take(4).collect();
    let tail = if tail.is_empty() { "0000".to_string() } else { tail.to_lowercase() };
    format!("tomo-{}-{}", slug(label), tail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_is_minted_once_and_then_kept() {
        let first = infra_name(None, "seoul", "a1b2c3d4e5f6");
        assert_eq!(first, "tomo-seoul-a1b2");
        // renamed, moved, restored somewhere else: the name does not move with it
        assert_eq!(infra_name(Some(&first), "renamed-entirely", "999999999999"), first);
        assert_eq!(infra_name(Some("  "), "seoul", "a1b2c3d4e5f6"), first, "a blank name is no name");
    }

    #[test]
    fn a_name_is_one_compose_accepts() {
        assert_eq!(slug("Scenario Comparisons"), "scenario-compari");
        assert_eq!(slug("feat/HOL-3219_fix"), "feat-hol-3219-fi");
        assert_eq!(slug("---"), "wt");
        assert_eq!(slug(""), "wt");
        assert_eq!(slug("a..b"), "a-b", "runs of punctuation make one dash");
        for label in ["Scenario Comparisons", "feat/HOL-3219_fix", "---", "", "ünïcødé"] {
            let name = infra_name(None, label, "deadbeef0000");
            assert!(name.starts_with("tomo-"));
            assert!(name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'), "{name}");
            assert!(!name.ends_with('-') && !name.contains("--"), "{name}");
            assert!(name.len() <= 26, "{name} is {} long", name.len());
        }
    }

    #[test]
    fn two_worktrees_with_one_name_do_not_share_infrastructure() {
        let a = infra_name(None, "seoul", "aaaa11112222");
        let b = infra_name(None, "seoul", "bbbb33334444");
        assert_ne!(a, b);
    }
}
