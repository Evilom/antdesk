use std::sync::{Mutex, OnceLock};
use tauri::Manager;
use tauri::Emitter;

#[derive(Default)]
struct AppState {
    notion_token: Mutex<Option<String>>,
}

const DEFAULT_NOTION_TOKEN: &str = "ntn_A74208512877NJgCuXKZv8qc4cy1jO8Zj2xWfIqwTA4dQY";

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

// ── Notion ──

#[tauri::command]
fn get_notion_token(state: tauri::State<AppState>) -> String {
    let mut cached = state.notion_token.lock().unwrap();
    if let Some(ref token) = *cached {
        return token.clone();
    }
    let token = std::env::var("NOTION_TOKEN").unwrap_or_else(|_| DEFAULT_NOTION_TOKEN.to_string());
    *cached = Some(token.clone());
    token
}

#[tauri::command]
fn clear_token_cache(state: tauri::State<AppState>) {
    let mut cached = state.notion_token.lock().unwrap();
    *cached = None;
}

#[tauri::command]
async fn fetch_notion(
    path: String,
    method: String,
    body: Option<String>,
    token: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let token = match token {
        Some(t) if !t.is_empty() => t,
        _ => {
            let cached = state.notion_token.lock().unwrap();
            cached.clone().unwrap_or_else(|| DEFAULT_NOTION_TOKEN.to_string())
        }
    };

    let url = format!("https://api.notion.com{}", path);
    let client = http_client();
    let mut req = match method.as_str() {
        "POST" => client.post(&url),
        "PATCH" => client.patch(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        _ => client.get(&url),
    };

    req = req
        .header("Authorization", format!("Bearer {}", token))
        .header("Notion-Version", "2022-06-28")
        .header("Content-Type", "application/json");

    if let Some(b) = body {
        if !b.is_empty() {
            req = req.body(b);
        }
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Notion API error ({}): {}", status, text));
    }
    Ok(text)
}

// ── Kanban fetch ──

#[tauri::command]
async fn fetch_kanban(url: Option<String>) -> Result<String, String> {
    let endpoint = url
        .filter(|u| !u.is_empty())
        .or_else(|| std::env::var("KANBAN_ENDPOINT").ok())
        .unwrap_or_default();

    if endpoint.is_empty() {
        return Ok(r#"{"actions":[],"completedToday":[],"exportedAt":"","stats":{"pending":0,"active":0,"blocked":0,"completedToday":0}}"#.to_string());
    }

    let client = http_client();
    let resp = client
        .get(&endpoint)
        .header("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(10))
        .send().await
        .map_err(|e| format!("Kanban fetch error: {}", e))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Kanban API error ({}): {}", status, text));
    }
    Ok(text)
}

// ── Main panel window management ──

#[tauri::command]
async fn window_minimize(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        w.minimize().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn window_maximize(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_maximized().unwrap_or(false) {
            w.unmaximize().map_err(|e| e.to_string())?;
        } else {
            w.maximize().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn window_close(app: tauri::AppHandle) -> Result<(), String> {
    // Hide main panel, pet stays visible
    if let Some(w) = app.get_webview_window("main") {
        w.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn is_maximized(app: tauri::AppHandle) -> Result<bool, String> {
    if let Some(w) = app.get_webview_window("main") {
        return w.is_maximized().map_err(|e| e.to_string());
    }
    Ok(false)
}

/// Show the main panel window
#[tauri::command]
async fn expand_panel(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        w.show().map_err(|e| e.to_string())?;
        w.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Hide the main panel window
#[tauri::command]
async fn collapse_panel(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        w.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Pet window management ──

/// Expand pet window to show QuickChat panel.
/// Checks screen bounds: expands right if space, otherwise left.
/// Returns "left" or "right" so frontend knows panel direction.
/// Get pet window screen position
#[tauri::command]
async fn get_pet_position(app: tauri::AppHandle) -> Result<(f64, f64), String> {
    if let Some(pet) = app.get_webview_window("pet") {
        let pos = pet.outer_position().map_err(|e| e.to_string())?;
        Ok((pos.x as f64, pos.y as f64))
    } else {
        Err("Pet window not found".to_string())
    }
}

/// Show the pet window
#[tauri::command]
async fn show_pet(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(pet) = app.get_webview_window("pet") {
        pet.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Hide the pet window
#[tauri::command]
async fn hide_pet(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(pet) = app.get_webview_window("pet") {
        pet.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Get pending todo count for badge
#[tauri::command]
async fn get_pending_count(state: tauri::State<'_, AppState>) -> Result<i32, String> {
    let token = {
        let cached = state.notion_token.lock().unwrap();
        cached.clone().unwrap_or_else(|| DEFAULT_NOTION_TOKEN.to_string())
    };

    let body = r#"{"filter":{"property":"Status","checkbox":{"equals":false}},"page_size":100}"#;
    let raw = fetch_notion(
        "/v1/databases/2d51ba51-3457-8125-9d4c-f28ffa2fff14/query".to_string(),
        "POST".to_string(),
        Some(body.to_string()),
        Some(token),
        state,
    ).await?;

    let data: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let count = data["results"].as_array().map(|a| a.len() as i32).unwrap_or(0);
    Ok(count)
}

/// Get screen bounds for PhysicsEngine
#[tauri::command]
async fn get_screen_bounds(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let pet = app.get_webview_window("pet").ok_or("Pet window not found")?;
    let monitor = pet.current_monitor().ok().flatten().ok_or("No monitor found")?;

    let scale = monitor.scale_factor();
    let pos = monitor.position();
    let size = monitor.size();

    let mon_x = pos.x as f64;
    let mon_y = pos.y as f64;
    let mon_w = size.width as f64;
    let mon_h = size.height as f64;

    let menu_bar_h = 25.0 * scale;
    let dock_h = 65.0 * scale;

    Ok(serde_json::json!({
        "x": mon_x,
        "y": mon_y + menu_bar_h,
        "width": mon_w,
        "height": mon_h - menu_bar_h - dock_h,
        "scale": scale,
    }))
}

/// Quit the app
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Show settings on main panel
#[tauri::command]
async fn show_settings(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        w.show().map_err(|e| e.to_string())?;
        w.set_focus().map_err(|e| e.to_string())?;
        let _ = w.emit("open-settings", ());
    }
    Ok(())
}

/// Toggle notepad window
#[tauri::command]
async fn toggle_notepad(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(np) = app.get_webview_window("notepad") {
        if np.is_visible().unwrap_or(false) {
            np.hide().map_err(|e| e.to_string())?;
        } else {
            np.show().map_err(|e| e.to_string())?;
            np.set_focus().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ── System tray ──

fn setup_tray(app: &tauri::App) {
    use tauri::image::Image;
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::TrayIconBuilder;

    let handle = app.handle().clone();

    let show_item = MenuItem::with_id(&handle, "show", "Show Panel", true, None::<&str>)
        .expect("failed to create show menu item");
    let settings_item = MenuItem::with_id(&handle, "settings", "Settings", true, None::<&str>)
        .expect("failed to create settings menu item");
    let separator = PredefinedMenuItem::separator(&handle).expect("failed to create separator");
    let quit_item = MenuItem::with_id(&handle, "quit", "Quit", true, None::<&str>)
        .expect("failed to create quit menu item");

    let menu = Menu::with_items(&handle, &[&show_item, &settings_item, &separator, &quit_item])
        .expect("failed to create tray menu");

    let icon_data = include_bytes!("../icons/32x32.png");
    let img = image::load_from_memory(icon_data).expect("failed to decode tray icon");
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    let icon = Image::new_owned(rgba.into_raw(), width, height);

    let _tray = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("AntDesk")
        .on_menu_event(move |app, event| {
            match event.id().as_ref() {
                "quit" => app.exit(0),
                "show" => {
                    let h = app.clone();
                    tauri::async_runtime::spawn(async move { let _ = expand_panel(h).await; });
                }
                "settings" => {
                    let h = app.clone();
                    tauri::async_runtime::spawn(async move { let _ = show_settings(h).await; });
                }
                _ => {}
            }
        })
        .build(&handle)
        .expect("failed to create tray icon");
}

// ── Entry point ──

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .manage(AppState::default())
        .setup(|app| {
            setup_tray(app);

            // Position pet at bottom-right of primary monitor
            let app_handle = app.handle().clone();
            if let Some(pet) = app_handle.get_webview_window("pet") {
                let monitor = pet.current_monitor().ok().flatten();
                let scale = monitor.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);
                let (mon_right, mon_bottom) = if let Some(ref m) = monitor {
                    let p = m.position();
                    let s = m.size();
                    (p.x as f64 + s.width as f64, p.y as f64 + s.height as f64)
                } else {
                    (1920.0 * scale, 1080.0 * scale)
                };
                let pet_w = 260.0 * scale;
                let pet_h = 260.0 * scale;
                let margin = 24.0 * scale;
                let x = mon_right - pet_w - margin;
                let y = mon_bottom - pet_h - margin;
                let pos = tauri::Position::Physical(tauri::PhysicalPosition::new(x as i32, y as i32));
                let _ = pet.set_position(pos);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_notion_token,
            clear_token_cache,
            fetch_notion,
            fetch_kanban,
            window_minimize,
            window_maximize,
            window_close,
            is_maximized,
            expand_panel,
            collapse_panel,
            get_pet_position,
            show_pet,
            hide_pet,
            get_pending_count,
            get_screen_bounds,
            show_settings,
            toggle_notepad,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
