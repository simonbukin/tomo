use tomo_proto::{Id, LayoutNode, SplitDirection};

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
        LayoutNode::Leaf { pane_id } if pane_id == target => LayoutNode::Split {
            id: split_id.to_string(),
            direction,
            ratio: 0.5,
            first: Box::new(node.clone()),
            second: Box::new(leaf(new_pane)),
        },
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
        LayoutNode::Split { id, direction, ratio, first, second } => {
            match (remove(first, target), remove(second, target)) {
                (None, Some(s)) => Some(s),
                (Some(f), None) => Some(f),
                (Some(f), Some(s)) => Some(LayoutNode::Split {
                    id: id.clone(),
                    direction: *direction,
                    ratio: *ratio,
                    first: Box::new(f),
                    second: Box::new(s),
                }),
                (None, None) => None,
            }
        }
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
            LayoutNode::Split { id: id.clone(), direction: *direction, ratio: a / (a + b), first: Box::new(equalize(first)), second: Box::new(equalize(second)) }
        }
    }
}

pub fn swap(node: &LayoutNode, a: &str, b: &str) -> LayoutNode {
    match node {
        LayoutNode::Leaf { pane_id } if pane_id == a => leaf(b),
        LayoutNode::Leaf { pane_id } if pane_id == b => leaf(a),
        LayoutNode::Leaf { .. } => node.clone(),
        LayoutNode::Split { id, direction, ratio, first, second } => LayoutNode::Split {
            id: id.clone(),
            direction: *direction,
            ratio: *ratio,
            first: Box::new(swap(first, a, b)),
            second: Box::new(swap(second, a, b)),
        },
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
        LayoutNode::Split { id, first, second, .. } => split_of(first, pane_id)
            .or_else(|| split_of(second, pane_id))
            .or_else(|| contains(node, pane_id).then(|| id.clone())),
    }
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
}
