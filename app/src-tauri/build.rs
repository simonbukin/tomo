const COMMANDS: &[&str] = &[
    "rpc",
    "daemon_connected",
    "browser_create",
    "browser_set_bounds",
    "browser_set_visible",
    "browser_navigate",
    "browser_back",
    "browser_forward",
    "browser_reload",
    "browser_close",
];

fn main() {
    let attributes = tauri_build::Attributes::default().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));
    tauri_build::try_build(attributes).expect("tauri build");
}
