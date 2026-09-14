use std::collections::HashSet;
use std::sync::OnceLock;
use tomo_proto::Town;

const DATA: &str = include_str!("../../../../app/src/data/japan-towns.json");
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
}
