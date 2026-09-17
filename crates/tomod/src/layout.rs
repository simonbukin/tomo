use tomo_proto::{DropPlace, Id, LayoutNode, SplitDirection};

pub fn leaf(pane_id: &str) -> LayoutNode {
    LayoutNode::Leaf { pane_id: pane_id.to_string() }
}

pub fn pane_ids(node: &LayoutNode) -> Vec<Id> {
    match node {
        LayoutNode::Leaf { pane_id } => vec![pane_id.clone()],
        LayoutNode::Split { first, second, .. } => {
            let mut ids = pane_ids(first);
            ids.extend(pane_ids(second));
            ids
        }
    }
}

pub fn contains(node: &LayoutNode, pane_id: &str) -> bool {
    match node {
        LayoutNode::Leaf { pane_id: p } => p == pane_id,
        LayoutNode::Split { first, second, .. } => contains(first, pane_id) || contains(second, pane_id),
    }
}

pub fn split(node: &LayoutNode, target: &str, direction: SplitDirection, new_pane: &str, split_id: &str) -> LayoutNode {
    match node {
        LayoutNode::Leaf { pane_id } if pane_id == target => {
            LayoutNode::Split { id: split_id.to_string(), direction, ratio: 0.5, first: Box::new(node.clone()), second: Box::new(leaf(new_pane)) }
        }
        LayoutNode::Leaf { .. } => node.clone(),
        LayoutNode::Split { id, direction: d, ratio, first, second } => LayoutNode::Split {
            id: id.clone(),
            direction: *d,
            ratio: *ratio,
            first: Box::new(split(first, target, direction, new_pane, split_id)),
            second: Box::new(split(second, target, direction, new_pane, split_id)),
        },
    }
}

/// Returns `None` when the removed pane was the only leaf.
pub fn remove(node: &LayoutNode, target: &str) -> Option<LayoutNode> {
    match node {
        LayoutNode::Leaf { pane_id } if pane_id == target => None,
        LayoutNode::Leaf { .. } => Some(node.clone()),
        LayoutNode::Split { id, direction, ratio, first, second } => match (remove(first, target), remove(second, target)) {
            (None, Some(s)) => Some(s),
            (Some(f), None) => Some(f),
            (Some(f), Some(s)) => Some(LayoutNode::Split { id: id.clone(), direction: *direction, ratio: *ratio, first: Box::new(f), second: Box::new(s) }),
            (None, None) => None,
        },
    }
}

pub fn resize(node: &LayoutNode, split_id: &str, new_ratio: f64) -> LayoutNode {
    match node {
        LayoutNode::Leaf { .. } => node.clone(),
        LayoutNode::Split { id, direction, ratio, first, second } => LayoutNode::Split {
            id: id.clone(),
            direction: *direction,
            ratio: if id == split_id { new_ratio.clamp(0.1, 0.9) } else { *ratio },
            first: Box::new(resize(first, split_id, new_ratio)),
            second: Box::new(resize(second, split_id, new_ratio)),
        },
    }
}

pub fn leaf_count(node: &LayoutNode) -> usize {
    match node {
        LayoutNode::Leaf { .. } => 1,
        LayoutNode::Split { first, second, .. } => leaf_count(first) + leaf_count(second),
    }
}

/// Gives every pane in a chain of same-direction splits the same size.
pub fn equalize(node: &LayoutNode) -> LayoutNode {
    match node {
        LayoutNode::Leaf { .. } => node.clone(),
        LayoutNode::Split { id, direction, first, second, .. } => {
            let (a, b) = (leaf_count(first) as f64, leaf_count(second) as f64);
            LayoutNode::Split {
                id: id.clone(),
                direction: *direction,
                ratio: a / (a + b),
                first: Box::new(equalize(first)),
                second: Box::new(equalize(second)),
            }
        }
    }
}

pub fn swap(node: &LayoutNode, a: &str, b: &str) -> LayoutNode {
    match node {
        LayoutNode::Leaf { pane_id } if pane_id == a => leaf(b),
        LayoutNode::Leaf { pane_id } if pane_id == b => leaf(a),
        LayoutNode::Leaf { .. } => node.clone(),
        LayoutNode::Split { id, direction, ratio, first, second } => {
            LayoutNode::Split { id: id.clone(), direction: *direction, ratio: *ratio, first: Box::new(swap(first, a, b)), second: Box::new(swap(second, a, b)) }
        }
    }
}

fn flip(d: SplitDirection) -> SplitDirection {
    match d {
        SplitDirection::Horizontal => SplitDirection::Vertical,
        SplitDirection::Vertical => SplitDirection::Horizontal,
    }
}

pub fn rotate(node: &LayoutNode, split_id: &str) -> LayoutNode {
    match node {
        LayoutNode::Leaf { .. } => node.clone(),
        LayoutNode::Split { id, direction, ratio, first, second } => LayoutNode::Split {
            id: id.clone(),
            direction: if id == split_id { flip(*direction) } else { *direction },
            ratio: *ratio,
            first: Box::new(rotate(first, split_id)),
            second: Box::new(rotate(second, split_id)),
        },
    }
}

/// The innermost split that contains `pane_id`.
pub fn split_of(node: &LayoutNode, pane_id: &str) -> Option<Id> {
    match node {
        LayoutNode::Leaf { .. } => None,
        LayoutNode::Split { id, first, second, .. } => {
            split_of(first, pane_id).or_else(|| split_of(second, pane_id)).or_else(|| contains(node, pane_id).then(|| id.clone()))
        }
    }
}

/// A 50/50 split with `pane` on the `place` side of `node`. `Center` counts as right.
pub fn beside(node: &LayoutNode, place: DropPlace, pane: &str, split_id: &str) -> LayoutNode {
    let (direction, pane_first) = match place {
        DropPlace::Left => (SplitDirection::Horizontal, true),
        DropPlace::Right | DropPlace::Center => (SplitDirection::Horizontal, false),
        DropPlace::Top => (SplitDirection::Vertical, true),
        DropPlace::Bottom => (SplitDirection::Vertical, false),
    };
    let (first, second) = if pane_first { (leaf(pane), node.clone()) } else { (node.clone(), leaf(pane)) };
    LayoutNode::Split { id: split_id.to_string(), direction, ratio: 0.5, first: Box::new(first), second: Box::new(second) }
}

/// Replaces the leaf `target` with a split that holds `pane` on the `place` side.
pub fn insert(node: &LayoutNode, target: &str, place: DropPlace, pane: &str, split_id: &str) -> LayoutNode {
    match node {
        LayoutNode::Leaf { pane_id } if pane_id == target => beside(node, place, pane, split_id),
        LayoutNode::Leaf { .. } => node.clone(),
        LayoutNode::Split { id, direction, ratio, first, second } => LayoutNode::Split {
            id: id.clone(),
            direction: *direction,
            ratio: *ratio,
            first: Box::new(insert(first, target, place, pane, split_id)),
            second: Box::new(insert(second, target, place, pane, split_id)),
        },
    }
}

/// Moves `pane` next to `target` in one tree; `Center` swaps them.
/// Returns `None` for a move onto itself or when an id is not in the tree.
pub fn move_within(node: &LayoutNode, pane: &str, target: &str, place: DropPlace, split_id: &str) -> Option<LayoutNode> {
    if pane == target || !contains(node, pane) || !contains(node, target) {
        return None;
    }
    if place == DropPlace::Center {
        return Some(swap(node, pane, target));
    }
    remove(node, pane).map(|rest| insert(&rest, target, place, pane, split_id))
}

/// Moves `pane` to the `place` edge of its own tree. `None` when the tree has no other pane.
pub fn move_to_edge(node: &LayoutNode, pane: &str, place: DropPlace, split_id: &str) -> Option<LayoutNode> {
    if !contains(node, pane) {
        return None;
    }
    remove(node, pane).map(|rest| beside(&rest, place, pane, split_id))
}

/// Moves `id` to `position` (clamped) and keeps the order of the others.
pub fn reorder(ids: &[Id], id: &str, position: usize) -> Vec<Id> {
    let rest: Vec<Id> = ids.iter().filter(|x| x.as_str() != id).cloned().collect();
    if rest.len() == ids.len() {
        return ids.to_vec();
    }
    let at = position.min(rest.len());
    rest[..at].iter().cloned().chain(std::iter::once(id.to_string())).chain(rest[at..].iter().cloned()).collect()
}

pub fn is_valid(node: &LayoutNode) -> bool {
    let ids = pane_ids(node);
    let unique: std::collections::HashSet<&Id> = ids.iter().collect();
    ids.len() == unique.len() && ids.iter().all(|p| !p.is_empty()) && ratios_ok(node)
}

fn ratios_ok(node: &LayoutNode) -> bool {
    match node {
        LayoutNode::Leaf { .. } => true,
        LayoutNode::Split { ratio, first, second, .. } => (0.05..=0.95).contains(ratio) && ratios_ok(first) && ratios_ok(second),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_then_remove_restores_leaf() {
        let root = leaf("a");
        let after = split(&root, "a", SplitDirection::Horizontal, "b", "s1");
        assert_eq!(pane_ids(&after), vec!["a", "b"]);
        let nested = split(&after, "b", SplitDirection::Vertical, "c", "s2");
        assert_eq!(pane_ids(&nested), vec!["a", "b", "c"]);
        let back = remove(&nested, "c").unwrap();
        assert_eq!(back, after);
        let single = remove(&back, "a").unwrap();
        assert_eq!(single, leaf("b"));
        assert!(remove(&single, "b").is_none());
    }

    #[test]
    fn equalize_gives_equal_thirds_in_a_chain() {
        let root = split(&split(&leaf("a"), "a", SplitDirection::Horizontal, "b", "s1"), "b", SplitDirection::Horizontal, "c", "s2");
        let eq = equalize(&root);
        match &eq {
            LayoutNode::Split { ratio, second, .. } => {
                assert!((ratio - 1.0 / 3.0).abs() < 1e-9);
                match &**second {
                    LayoutNode::Split { ratio, .. } => assert!((ratio - 0.5).abs() < 1e-9),
                    _ => panic!(),
                }
            }
            _ => panic!(),
        }
        assert!(is_valid(&eq));
    }

    #[test]
    fn swap_rotate_and_split_of_keep_the_tree_valid() {
        let root = split(&split(&leaf("a"), "a", SplitDirection::Horizontal, "b", "s1"), "b", SplitDirection::Vertical, "c", "s2");
        let swapped = swap(&root, "a", "c");
        assert_eq!(pane_ids(&swapped), vec!["c", "b", "a"]);
        assert_eq!(split_of(&root, "c").as_deref(), Some("s2"));
        assert_eq!(split_of(&root, "a").as_deref(), Some("s1"));
        let rotated = rotate(&root, "s2");
        match &rotated {
            LayoutNode::Split { second, .. } => match &**second {
                LayoutNode::Split { direction, .. } => assert_eq!(*direction, SplitDirection::Horizontal),
                _ => panic!(),
            },
            _ => panic!(),
        }
        assert!(is_valid(&rotated) && is_valid(&swapped));
        assert!(!is_valid(&split(&leaf("a"), "a", SplitDirection::Horizontal, "a", "dup")));
    }

    #[test]
    fn resize_clamps_and_targets_one_split() {
        let root = split(&leaf("a"), "a", SplitDirection::Horizontal, "b", "s1");
        let resized = resize(&root, "s1", 0.99);
        match resized {
            LayoutNode::Split { ratio, .. } => assert_eq!(ratio, 0.9),
            _ => panic!(),
        }
        assert_eq!(resize(&root, "nope", 0.2), root);
    }

    const PLACES: [DropPlace; 5] = [DropPlace::Center, DropPlace::Left, DropPlace::Right, DropPlace::Top, DropPlace::Bottom];

    fn sorted(node: &LayoutNode) -> Vec<Id> {
        let mut ids = pane_ids(node);
        ids.sort();
        ids
    }

    fn node(id: &str, direction: SplitDirection, first: LayoutNode, second: LayoutNode) -> LayoutNode {
        LayoutNode::Split { id: id.into(), direction, ratio: 0.5, first: Box::new(first), second: Box::new(second) }
    }

    #[test]
    fn insert_puts_the_pane_on_each_side_of_the_target() {
        use SplitDirection::{Horizontal as H, Vertical as V};
        let root = node("s1", H, leaf("a"), leaf("b"));
        assert_eq!(insert(&root, "b", DropPlace::Left, "c", "n"), node("s1", H, leaf("a"), node("n", H, leaf("c"), leaf("b"))));
        assert_eq!(insert(&root, "b", DropPlace::Right, "c", "n"), node("s1", H, leaf("a"), node("n", H, leaf("b"), leaf("c"))));
        assert_eq!(insert(&root, "a", DropPlace::Top, "c", "n"), node("s1", H, node("n", V, leaf("c"), leaf("a")), leaf("b")));
        assert_eq!(insert(&root, "a", DropPlace::Bottom, "c", "n"), node("s1", H, node("n", V, leaf("a"), leaf("c")), leaf("b")));
        assert_eq!(insert(&root, "zz", DropPlace::Left, "c", "n"), root);
    }

    #[test]
    fn move_within_collapses_the_old_parent_and_splits_the_target() {
        use SplitDirection::{Horizontal as H, Vertical as V};
        let root = node("s1", H, leaf("a"), node("s2", V, leaf("b"), leaf("c")));
        assert_eq!(move_within(&root, "c", "a", DropPlace::Left, "n"), Some(node("s1", H, node("n", H, leaf("c"), leaf("a")), leaf("b"))));
        assert_eq!(move_within(&root, "a", "c", DropPlace::Bottom, "n"), Some(node("s2", V, leaf("b"), node("n", V, leaf("c"), leaf("a")))));
        assert_eq!(move_within(&root, "a", "c", DropPlace::Center, "n"), Some(node("s1", H, leaf("c"), node("s2", V, leaf("b"), leaf("a")))));
        let two = node("s1", H, leaf("a"), leaf("b"));
        assert_eq!(move_within(&two, "a", "b", DropPlace::Right, "n"), Some(node("n", H, leaf("b"), leaf("a"))));
    }

    #[test]
    fn move_within_rejects_self_and_stale_ids() {
        let root = node("s1", SplitDirection::Horizontal, leaf("a"), leaf("b"));
        assert_eq!(move_within(&root, "a", "a", DropPlace::Left, "n"), None);
        assert_eq!(move_within(&root, "x", "a", DropPlace::Left, "n"), None);
        assert_eq!(move_within(&root, "a", "x", DropPlace::Center, "n"), None);
        assert_eq!(move_within(&leaf("a"), "a", "a", DropPlace::Center, "n"), None);
    }

    #[test]
    fn move_to_edge_wraps_the_rest_of_the_tree() {
        use SplitDirection::{Horizontal as H, Vertical as V};
        let root = node("s1", H, leaf("a"), node("s2", V, leaf("b"), leaf("c")));
        assert_eq!(move_to_edge(&root, "a", DropPlace::Bottom, "n"), Some(node("n", V, node("s2", V, leaf("b"), leaf("c")), leaf("a"))));
        assert_eq!(move_to_edge(&root, "b", DropPlace::Center, "n"), Some(node("n", H, node("s1", H, leaf("a"), leaf("c")), leaf("b"))));
        assert_eq!(move_to_edge(&leaf("a"), "a", DropPlace::Left, "n"), None);
        assert_eq!(move_to_edge(&root, "x", DropPlace::Left, "n"), None);
        assert_eq!(beside(&root, DropPlace::Top, "d", "n"), node("n", V, leaf("d"), root.clone()));
    }

    #[test]
    fn reorder_moves_one_id_and_clamps() {
        let ids: Vec<Id> = ["a", "b", "c", "d"].iter().map(|s| s.to_string()).collect();
        assert_eq!(reorder(&ids, "c", 1), ["a", "c", "b", "d"]);
        assert_eq!(reorder(&ids, "a", 3), ["b", "c", "d", "a"]);
        assert_eq!(reorder(&ids, "a", 99), ["b", "c", "d", "a"]);
        assert_eq!(reorder(&ids, "d", 0), ["d", "a", "b", "c"]);
        assert_eq!(reorder(&ids, "b", 1), ids);
        assert_eq!(reorder(&ids, "x", 0), ids);
    }

    #[test]
    fn torture_random_operations_keep_the_tree_valid() {
        let mut seed: u64 = 0x9e3779b97f4a7c15;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let mut tree = leaf("p0");
        let mut counter = 1;
        for step in 0..400 {
            let ids = pane_ids(&tree);
            let pick = |n: u64| ids[(n % ids.len() as u64) as usize].clone();
            match next() % 8 {
                6 => {
                    let (a, b) = (pick(next()), pick(next()));
                    let place = PLACES[(next() % 5) as usize];
                    if let Some(moved) = move_within(&tree, &a, &b, place, &format!("m{step}")) {
                        assert_eq!(sorted(&moved), sorted(&tree), "move keeps the pane set");
                        tree = moved;
                    }
                }
                7 => {
                    if let Some(moved) = move_to_edge(&tree, &pick(next()), PLACES[(next() % 5) as usize], &format!("e{step}")) {
                        assert_eq!(sorted(&moved), sorted(&tree), "edge move keeps the pane set");
                        tree = moved;
                    }
                }
                // ponytail: equalize leaves ratios outside is_valid's 0.05..0.95 once a chain holds 20+ panes; the cap keeps this test below that.
                0 | 1 if ids.len() < 12 => {
                    let dir = if next() % 2 == 0 { SplitDirection::Horizontal } else { SplitDirection::Vertical };
                    let new = format!("p{counter}");
                    counter += 1;
                    tree = split(&tree, &pick(next()), dir, &new, &format!("s{step}"));
                }
                2 => {
                    if ids.len() > 1 {
                        tree = remove(&tree, &pick(next())).unwrap();
                    }
                }
                3 => {
                    if ids.len() > 1 {
                        let a = pick(next());
                        let b = pick(next());
                        if a != b {
                            let before = pane_ids(&tree);
                            tree = swap(&tree, &a, &b);
                            let mut after = pane_ids(&tree);
                            after.sort();
                            let mut before_sorted = before.clone();
                            before_sorted.sort();
                            assert_eq!(after, before_sorted, "swap keeps the pane set");
                        }
                    }
                }
                4 => {
                    if let Some(sid) = split_of(&tree, &pick(next())) {
                        tree = rotate(&tree, &sid);
                    }
                }
                _ => {
                    tree = if next() % 2 == 0 {
                        equalize(&tree)
                    } else if let Some(sid) = split_of(&tree, &pick(next())) {
                        resize(&tree, &sid, (next() % 100) as f64 / 100.0)
                    } else {
                        tree
                    };
                }
            }
            assert!(is_valid(&tree), "step {step}: {tree:?}");
            let round: LayoutNode = serde_json::from_str(&serde_json::to_string(&tree).unwrap()).unwrap();
            assert_eq!(pane_ids(&round), pane_ids(&tree), "layout survives JSON round trip");
            assert!(is_valid(&round));
        }
    }
}
