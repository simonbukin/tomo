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
