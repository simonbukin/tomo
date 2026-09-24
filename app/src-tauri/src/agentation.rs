//! Agentation in the Tauri host: the overlay bundle, the annotate flag of each browser pane, and the commands of the overlay.
//! It uses Browser, and Browser reaches it only through the page-load and close hooks that `lib.rs` lists.

use crate::browser::browser_webview;
use serde_json::json;
use std::collections::HashSet;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, Webview};

const AGENTATION_JS: &str = include_str!("../agentation/agentation.js");

#[derive(Default)]
pub struct AnnotatePanes(Mutex<HashSet<String>>);

impl AnnotatePanes {
    fn contains(&self, pane_id: &str) -> bool {
        self.0.lock().unwrap().contains(pane_id)
    }
}

/// Enabling evaluates the bundle once for each page; disabling only unmounts an overlay that the page already has.
fn agentation_script(enabled: bool) -> String {
    if enabled {
        format!("if(!window.__tomoAgentation){{{AGENTATION_JS}\n}}window.__tomoAgentation.set(true);")
    } else {
        "window.__tomoAgentation&&window.__tomoAgentation.set(false);".to_string()
    }
}

fn page_load_script(annotating: bool) -> Option<String> {
    annotating.then(|| agentation_script(true))
}

/// Browser page-load hook: a new page has no overlay, so a pane with annotate on gets it again.
pub fn page_loaded(webview: &Webview, pane_id: &str) {
    if let Some(script) = page_load_script(webview.state::<AnnotatePanes>().contains(pane_id)) {
        let _ = webview.eval(script);
    }
}

/// Browser close hook.
pub fn closed(app: &AppHandle, pane_id: &str) {
    app.state::<AnnotatePanes>().0.lock().unwrap().remove(pane_id);
}

#[tauri::command]
pub async fn browser_set_annotate(app: AppHandle, annotate: State<'_, AnnotatePanes>, pane_id: String, enabled: bool) -> Result<(), String> {
    {
        let mut panes = annotate.0.lock().unwrap();
        if enabled {
            panes.insert(pane_id.clone())
        } else {
            panes.remove(&pane_id)
        };
    }
    let wv = browser_webview(&app, &pane_id)?;
    wv.eval(agentation_script(enabled)).map_err(|e| e.to_string())?;
    if enabled {
        wv.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_clear_annotations(app: AppHandle, pane_id: String) -> Result<(), String> {
    browser_webview(&app, &pane_id)?.eval("window.__tomoAgentation && window.__tomoAgentation.clear()").map_err(|e| e.to_string())
}

fn feedback_pane<'a>(label: &'a str, kind: &str, annotating: impl Fn(&str) -> bool) -> Result<&'a str, String> {
    let pane_id = label.strip_prefix("browser-").ok_or("not a browser webview")?;
    match kind {
        "change" => Ok(pane_id),
        "copy" | "submit" if annotating(pane_id) => Ok(pane_id),
        "copy" | "submit" => Err("annotate is off for this pane".into()),
        _ => Err(format!("unknown feedback kind {kind}")),
    }
}

/// Called by the page inside a browser webview. The pane comes from the webview label, never from the page.
#[tauri::command]
pub fn browser_feedback(
    app: AppHandle,
    webview: Webview,
    annotate: State<'_, AnnotatePanes>,
    kind: String,
    count: u32,
    markdown: String,
) -> Result<(), String> {
    let pane_id = feedback_pane(webview.label(), &kind, |p| annotate.contains(p))?;
    app.emit_to("main", "browser://feedback", json!({ "pane_id": pane_id, "kind": kind, "count": count, "markdown": markdown })).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feedback_pane_comes_from_the_label_and_gates_copy_and_submit() {
        let on = |p: &str| p == "p1";
        assert_eq!(feedback_pane("browser-p1", "change", on), Ok("p1"));
        assert_eq!(feedback_pane("browser-p2", "change", on), Ok("p2"));
        assert_eq!(feedback_pane("browser-p1", "copy", on), Ok("p1"));
        assert_eq!(feedback_pane("browser-p1", "submit", on), Ok("p1"));
        assert!(feedback_pane("browser-p2", "copy", on).is_err());
        assert!(feedback_pane("browser-p1", "eval", on).is_err());
        assert!(feedback_pane("main", "change", on).is_err());
    }

    #[test]
    fn agentation_script_injects_once_then_toggles() {
        let script = agentation_script(true);
        assert!(script.starts_with("if(!window.__tomoAgentation){"));
        assert!(script.ends_with("}window.__tomoAgentation.set(true);"));
        assert!(agentation_script(false).ends_with("set(false);"));
    }

    #[test]
    fn only_enabling_carries_the_bundle() {
        assert!(agentation_script(true).contains(AGENTATION_JS));
        assert!(!agentation_script(false).contains(AGENTATION_JS));
        assert!(agentation_script(false).len() < 100);
    }

    #[test]
    fn a_page_load_injects_again_only_while_annotate_is_on() {
        assert_eq!(page_load_script(true), Some(agentation_script(true)));
        assert_eq!(page_load_script(false), None);
    }
}
