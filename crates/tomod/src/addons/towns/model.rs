use std::collections::HashSet;
use std::sync::OnceLock;
use tomo_proto::{ActivityEvent, ActivityKind, PullRequest, Town, TownHistory, TownPr, TownUnlock, TownWorktreeStatus};

const DATA: &str = include_str!("../../../../../app/src/addons/towns/data/japan-towns.json");
const WEIGHTS: [(&str, u32); 5] = [("common", 55), ("uncommon", 25), ("rare", 13), ("epic", 5), ("legendary", 2)];

pub fn all() -> &'static [Town] {
    static TOWNS: OnceLock<Vec<Town>> = OnceLock::new();
    TOWNS.get_or_init(|| serde_json::from_str(DATA).unwrap_or_default())
}

pub fn find(slug: &str) -> Option<&'static Town> {
    all().iter().find(|t| t.slug == slug)
}

fn random_below(n: usize) -> usize {
    (uuid::Uuid::new_v4().as_u128() % n as u128) as usize
}

pub fn pick(unlocked: &HashSet<String>) -> Option<&'static Town> {
    let available = |rarity: &str| all().iter().filter(|t| t.rarity == rarity && !unlocked.contains(&t.slug)).collect::<Vec<_>>();
    let tiers: Vec<(&str, u32, Vec<&Town>)> = WEIGHTS.iter().map(|(r, w)| (*r, *w, available(r))).filter(|(_, _, v)| !v.is_empty()).collect();
    let total: u32 = tiers.iter().map(|(_, w, _)| w).sum();
    if total == 0 {
        return None;
    }
    let mut roll = random_below(total as usize) as u32;
    let (_, _, pool) = tiers.iter().find(|(_, w, _)| {
        if roll < *w {
            return true;
        }
        roll -= w;
        false
    })?;
    Some(pool[random_below(pool.len())])
}

/// The live facts about the worktree that unlocked a town, when Tomo still knows it.
pub struct WorktreeFacts {
    pub name: String,
    pub branch: Option<String>,
    pub head: String,
    pub exists: bool,
    pub archived_at_ms: Option<u64>,
}

fn newest(events: &[ActivityEvent], kind: ActivityKind) -> Option<&ActivityEvent> {
    events.iter().filter(|e| e.kind == kind).max_by_key(|e| e.occurred_at_ms)
}

fn payload_str(e: &ActivityEvent, key: &str) -> Option<String> {
    e.payload.get(key).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(str::to_string)
}

/// `events` are the activity events of the unlocking worktree; `pr` is the cached pull request, if any.
pub fn history(unlock: TownUnlock, repo_name: Option<String>, worktree: Option<WorktreeFacts>, events: &[ActivityEvent], pr: Option<&PullRequest>) -> TownHistory {
    let archive = newest(events, ActivityKind::Archived);
    let status = match &worktree {
        None => TownWorktreeStatus::Gone,
        Some(w) if w.archived_at_ms.is_some() => TownWorktreeStatus::Archived,
        Some(w) if !w.exists => TownWorktreeStatus::Missing,
        Some(_) => TownWorktreeStatus::Active,
    };
    let archived_commit = archive.and_then(|e| payload_str(e, "checkpoint_commit").or_else(|| payload_str(e, "head")));
    let final_commit = match status {
        TownWorktreeStatus::Active | TownWorktreeStatus::Missing => worktree.as_ref().map(|w| w.head.clone()).filter(|h| !h.is_empty()).or(archived_commit),
        TownWorktreeStatus::Archived | TownWorktreeStatus::Gone => archived_commit,
    };
    let archived_at_ms = match status {
        TownWorktreeStatus::Archived => worktree.as_ref().and_then(|w| w.archived_at_ms),
        TownWorktreeStatus::Gone => archive.map(|e| e.occurred_at_ms),
        _ => None,
    };
    let pr = pr.map(|p| TownPr { number: p.number, url: p.url.clone(), state: p.state.clone() }).or_else(|| {
        let e = newest(events, ActivityKind::PrMerged)?;
        Some(TownPr { number: e.payload.get("number")?.as_u64()?, url: payload_str(e, "url")?, state: "merged".into() })
    });
    TownHistory {
        branch: worktree.as_ref().and_then(|w| w.branch.clone()).or_else(|| archive.and_then(|e| payload_str(e, "branch"))),
        worktree_name: worktree.map(|w| w.name),
        unlock,
        repo_name,
        status,
        final_commit,
        archived_at_ms,
        pr,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dataset_loads_and_covers_every_tier() {
        assert!(all().len() > 1000);
        for (rarity, _) in WEIGHTS {
            assert!(all().iter().any(|t| t.rarity == rarity), "no towns with rarity {rarity}");
        }
    }

    #[test]
    fn pick_skips_unlocked_and_exhausts() {
        let unlocked: HashSet<String> = all().iter().filter(|t| t.rarity != "legendary").map(|t| t.slug.clone()).collect();
        for _ in 0..50 {
            let t = pick(&unlocked).unwrap();
            assert!(!unlocked.contains(&t.slug));
            assert_eq!(t.rarity, "legendary");
        }
        let everything: HashSet<String> = all().iter().map(|t| t.slug.clone()).collect();
        assert!(pick(&everything).is_none());
    }

    fn unlock() -> TownUnlock {
        TownUnlock { slug: "aogashima".into(), worktree_id: "w1".into(), repo_id: "r1".into(), unlocked_at_ms: 10 }
    }

    fn event(kind: ActivityKind, at: u64, payload: serde_json::Value) -> ActivityEvent {
        ActivityEvent { id: format!("e{at}"), kind, occurred_at_ms: at, worktree_id: Some("w1".into()), pane_id: None, agent_kind: None, title: String::new(), detail: None, payload, attention_id: None }
    }

    fn facts(archived_at_ms: Option<u64>) -> WorktreeFacts {
        WorktreeFacts { name: "Aogashima".into(), branch: Some("feat/labor".into()), head: if archived_at_ms.is_some() { String::new() } else { "abc1234".into() }, exists: archived_at_ms.is_none(), archived_at_ms }
    }

    #[test]
    fn history_of_an_active_town_uses_the_live_head() {
        let h = history(unlock(), Some("tomo".into()), Some(facts(None)), &[], None);
        assert_eq!(h.status, TownWorktreeStatus::Active);
        assert_eq!((h.branch.as_deref(), h.final_commit.as_deref(), h.repo_name.as_deref(), h.worktree_name.as_deref()), (Some("feat/labor"), Some("abc1234"), Some("tomo"), Some("Aogashima")));
        assert_eq!((h.archived_at_ms, h.pr), (None, None));
    }

    #[test]
    fn history_of_an_archived_town_uses_the_archive_record() {
        let events = [
            event(ActivityKind::Archived, 50, serde_json::json!({ "branch": "feat/labor", "checkpoint_commit": null, "head": "old0001" })),
            event(ActivityKind::Restored, 60, serde_json::json!({})),
            event(ActivityKind::Archived, 90, serde_json::json!({ "branch": "feat/labor", "checkpoint_commit": "8c1fd62", "head": "old0002" })),
            event(ActivityKind::PrMerged, 70, serde_json::json!({ "number": 12, "url": "https://github.com/o/r/pull/12" })),
        ];
        let h = history(unlock(), None, Some(facts(Some(95))), &events, None);
        assert_eq!(h.status, TownWorktreeStatus::Archived);
        assert_eq!((h.final_commit.as_deref(), h.archived_at_ms), (Some("8c1fd62"), Some(95)));
        assert_eq!(h.pr, Some(TownPr { number: 12, url: "https://github.com/o/r/pull/12".into(), state: "merged".into() }));
    }

    #[test]
    fn a_clean_archive_falls_back_to_the_head_at_archive_time() {
        let events = [event(ActivityKind::Archived, 50, serde_json::json!({ "branch": "feat/clean", "checkpoint_commit": null, "head": "head777" }))];
        let h = history(unlock(), None, None, &events, None);
        assert_eq!(h.status, TownWorktreeStatus::Gone);
        assert_eq!((h.branch.as_deref(), h.final_commit.as_deref(), h.archived_at_ms, h.worktree_name), (Some("feat/clean"), Some("head777"), Some(50), None));
    }

    #[test]
    fn a_cached_pull_request_wins_over_the_merge_event() {
        let pr = PullRequest { number: 3, title: "t".into(), url: "u".into(), state: "open".into(), draft: false, review_decision: None, mergeable: None, checks_passed: 0, checks_failed: 0, checks_pending: 0, fetched_at_ms: 1 };
        let events = [event(ActivityKind::PrMerged, 70, serde_json::json!({ "number": 12, "url": "x" }))];
        let h = history(unlock(), None, Some(facts(None)), &events, Some(&pr));
        assert_eq!(h.pr.map(|p| (p.number, p.state)), Some((3, "open".to_string())));
    }
}
