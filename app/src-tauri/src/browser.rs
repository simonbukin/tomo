use crate::{BROWSER_CLOSED, BROWSER_PAGE_LOADED};
use serde_json::{json, Value};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, Url, Webview, WebviewUrl};

fn browser_label(pane_id: &str) -> String {
    format!("browser-{pane_id}")
}

pub(crate) fn browser_webview(app: &AppHandle, pane_id: &str) -> Result<Webview, String> {
    app.get_webview(&browser_label(pane_id)).ok_or_else(|| format!("no browser webview for pane {pane_id}"))
}

fn emit_browser_state(app: &AppHandle, pane_id: &str, patch: Value) {
    let mut payload = json!({ "pane_id": pane_id });
    if let (Some(out), Some(fields)) = (payload.as_object_mut(), patch.as_object()) {
        out.extend(fields.clone());
    }
    let _ = app.emit_to("main", "browser://state", payload);
}

fn bounds(x: f64, y: f64, width: f64, height: f64) -> Rect {
    Rect { position: LogicalPosition::new(x, y).into(), size: LogicalSize::new(width.max(1.0), height.max(1.0)).into() }
}

#[tauri::command]
pub async fn browser_create(app: AppHandle, pane_id: String, url: String, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    if let Ok(existing) = browser_webview(&app, &pane_id) {
        return existing.set_bounds(bounds(x, y, width, height)).map_err(|e| e.to_string());
    }
    let window = app.get_window("main").ok_or("main window missing")?;
    let target = Url::parse(&url).map_err(|e| e.to_string())?;
    let label = browser_label(&pane_id);
    let (nav_app, nav_pane) = (app.clone(), pane_id.clone());
    let (load_app, load_pane) = (app.clone(), pane_id.clone());
    let (title_app, title_pane) = (app.clone(), pane_id.clone());
    let (popup_app, popup_label) = (app.clone(), label.clone());
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(target))
        .on_navigation(move |u| {
            emit_browser_state(&nav_app, &nav_pane, json!({ "url": u.as_str(), "loading": true }));
            true
        })
        .on_page_load(move |wv, payload| {
            let loading = matches!(payload.event(), PageLoadEvent::Started);
            emit_browser_state(&load_app, &load_pane, json!({ "url": payload.url().as_str(), "loading": loading }));
            if !loading {
                BROWSER_PAGE_LOADED.iter().for_each(|hook| hook(&wv, &load_pane));
            }
        })
        .on_document_title_changed(move |_, title| emit_browser_state(&title_app, &title_pane, json!({ "title": title })))
        .on_new_window(move |u, _| {
            if let Some(wv) = popup_app.get_webview(&popup_label) {
                let _ = wv.navigate(u);
            }
            NewWindowResponse::Deny
        });
    window.add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(width.max(1.0), height.max(1.0))).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn browser_set_bounds(app: AppHandle, pane_id: String, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    browser_webview(&app, &pane_id)?.set_bounds(bounds(x, y, width, height)).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_set_visible(app: AppHandle, pane_id: String, visible: bool) -> Result<(), String> {
    let wv = browser_webview(&app, &pane_id)?;
    if visible { wv.show() } else { wv.hide() }.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_navigate(app: AppHandle, pane_id: String, url: String) -> Result<(), String> {
    let target = Url::parse(&url).map_err(|e| e.to_string())?;
    browser_webview(&app, &pane_id)?.navigate(target).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_back(app: AppHandle, pane_id: String) -> Result<(), String> {
    browser_webview(&app, &pane_id)?.eval("history.back()").map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_forward(app: AppHandle, pane_id: String) -> Result<(), String> {
    browser_webview(&app, &pane_id)?.eval("history.forward()").map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_reload(app: AppHandle, pane_id: String) -> Result<(), String> {
    browser_webview(&app, &pane_id)?.reload().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_close(app: AppHandle, pane_id: String) -> Result<(), String> {
    BROWSER_CLOSED.iter().for_each(|hook| hook(&app, &pane_id));
    match browser_webview(&app, &pane_id) {
        Ok(wv) => wv.close().map_err(|e| e.to_string()),
        Err(_) => Ok(()),
    }
}
