use std::sync::{Mutex, OnceLock};
use tauri::Manager;
use tauri::Emitter;

#[derive(Default)]
struct AppState {
    notion_token: Mutex<Option<String>>,
}

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
    let token = std::env::var("NOTION_TOKEN").unwrap_or_default();
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
            cached.clone().unwrap_or_default()
        }
    };
    if token.trim().is_empty() {
        return Err("Notion token is not configured".to_string());
    }

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
async fn get_pending_count(
    token: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<i32, String> {
    let token = match token {
        Some(t) if !t.is_empty() => t,
        _ => {
            let cached = state.notion_token.lock().unwrap();
            cached.clone().unwrap_or_default()
        }
    };
    if token.trim().is_empty() {
        return Ok(0);
    }

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

/// Get positions of all visible application windows (macOS only).
/// Uses CGWindowListCopyWindowInfo via Python/PyObjC for reliability.
/// Returns array of {name, x, y, width, height} in physical pixels.
#[tauri::command]
async fn get_visible_windows() -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;

        let output = Command::new("python3")
            .args(["-c", r#"
import Quartz, json, sys
info = Quartz.CGWindowListCopyWindowInfo(
    Quartz.kCGWindowListOptionOnScreenOnly,
    Quartz.kCGNullWindowID
)
r = []
for w in info:
    b = w.get('kCGWindowBounds', {})
    if (w.get('kCGWindowLayer') == 0
        and w.get('kCGWindowAlpha', 0) > 0
        and b.get('Width', 0) > 100
        and b.get('Height', 0) > 100):
        r.append({
            'name': w.get('kCGWindowOwnerName', ''),
            'x': b.get('X', 0), 'y': b.get('Y', 0),
            'width': b.get('Width', 0), 'height': b.get('Height', 0)
        })
json.dump(r, sys.stdout)
"#])
            .output()
            .map_err(|e| format!("python3 failed: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("python3 error: {}", stderr));
        }

        let raw = String::from_utf8_lossy(&output.stdout);
        let windows: Vec<serde_json::Value> = serde_json::from_str(&raw)
            .map_err(|e| format!("JSON parse error: {}", e))?;
        Ok(serde_json::json!(windows))
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(serde_json::json!([]))
    }
}

/// Get screen bounds for PhysicsEngine — union of ALL monitors.
/// This handles dual/multi-screen setups correctly.
#[tauri::command]
async fn get_screen_bounds(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let pet = app.get_webview_window("pet").ok_or("Pet window not found")?;

    let monitors = pet.available_monitors().map_err(|e| e.to_string())?;
    if monitors.is_empty() {
        return Ok(serde_json::json!({
            "x": 0.0, "y": 25.0, "width": 1920.0, "height": 990.0, "scale": 1.0
        }));
    }

    // Compute union of all monitors
    let mut min_x: f64 = f64::MAX;
    let mut min_y: f64 = f64::MAX;
    let mut max_x: f64 = f64::MIN;
    let mut max_y: f64 = f64::MIN;
    let mut primary_scale: f64 = 1.0;

    for m in &monitors {
        let p = m.position();
        let s = m.size();
        let scale = m.scale_factor();
        let x = p.x as f64;
        let y = p.y as f64;
        let w = s.width as f64;
        let h = s.height as f64;
        if x < min_x { min_x = x; }
        if y < min_y { min_y = y; }
        if x + w > max_x { max_x = x + w; }
        if y + h > max_y { max_y = y + h; }
        // Use scale from the monitor where the pet currently is
        if x <= 0.0 && y <= 0.0 { primary_scale = scale; }
    }

    // Get current monitor for scale factor
    if let Ok(Some(current)) = pet.current_monitor() {
        primary_scale = current.scale_factor();
    }

    let scale = primary_scale;
    let menu_bar_h = 25.0 * scale;  // macOS menu bar (primary only, but safe padding)
    let dock_h = 8.0 * scale;       // Minimal dock padding — OS handles actual dock avoidance

    Ok(serde_json::json!({
        "x": min_x,
        "y": min_y + menu_bar_h,
        "width": max_x - min_x,
        "height": (max_y - min_y) - menu_bar_h - dock_h,
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

fn position_panel_next_to_pet(
    app: &tauri::AppHandle,
    label: &str,
    panel_w: f64,
    panel_h: f64,
) -> Result<(), String> {
    let panel = match app.get_webview_window(label) {
        Some(w) => w,
        None => return Ok(()),
    };

    if let Some(pet) = app.get_webview_window("pet") {
        let pet_pos = pet.outer_position().map_err(|e| e.to_string())?;
        let pet_size = pet.outer_size().map_err(|e| e.to_string())?;
        let monitor = pet.current_monitor().ok().flatten();
        let scale = monitor.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);

        let (mon_left, mon_right, mon_top, mon_bottom) = if let Some(ref m) = monitor {
            let p = m.position();
            let s = m.size();
            let menu_bar = 25.0 * scale;
            let dock = 65.0 * scale;
            (
                p.x as f64,
                p.x as f64 + s.width as f64,
                p.y as f64 + menu_bar,
                p.y as f64 + s.height as f64 - dock,
            )
        } else {
            (0.0, 1920.0 * scale, 25.0 * scale, 1015.0 * scale)
        };

        let gap = 8.0 * scale;
        let pw = panel_w * scale;
        let ph = panel_h * scale;
        let px = pet_pos.x as f64;
        let py = pet_pos.y as f64;
        let pet_w = pet_size.width as f64;

        let right_fits = px + pet_w + gap + pw <= mon_right;
        let left_fits = px - gap - pw >= mon_left;
        let x = if right_fits {
            px + pet_w + gap
        } else if left_fits {
            px - gap - pw
        } else {
            px.max(mon_left).min(mon_right - pw)
        };

        let y = if right_fits || left_fits {
            py.max(mon_top).min(mon_bottom - ph)
        } else {
            (py - gap - ph).max(mon_top)
        };

        let pos = tauri::Position::Physical(tauri::PhysicalPosition::new(x as i32, y as i32));
        panel.set_position(pos).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Toggle notepad window
/// Toggle quick panel (notepad) — positioned next to pet, never covering it.
#[tauri::command]
async fn toggle_notepad(app: tauri::AppHandle) -> Result<(), String> {
    let np = match app.get_webview_window("notepad") {
        Some(w) => w,
        None => return Ok(()),
    };

    // If visible → hide
    if np.is_visible().unwrap_or(false) {
        np.hide().map_err(|e| e.to_string())?;
        return Ok(());
    }

    position_panel_next_to_pet(&app, "notepad", 280.0, 360.0)?;

    np.show().map_err(|e| e.to_string())?;
    np.set_focus().map_err(|e| e.to_string())?;
    let _ = np.emit("notepad-shown", ());
    Ok(())
}

#[tauri::command]
async fn update_quick_panel_position(app: tauri::AppHandle) -> Result<(), String> {
    position_panel_next_to_pet(&app, "quick", 260.0, 320.0)?;
    position_panel_next_to_pet(&app, "notepad", 280.0, 360.0)?;
    Ok(())
}

#[tauri::command]
async fn toggle_quick_panel(app: tauri::AppHandle) -> Result<(), String> {
    if app.get_webview_window("quick").is_some() {
        position_panel_next_to_pet(&app, "quick", 260.0, 320.0)?;
        if let Some(q) = app.get_webview_window("quick") {
            if q.is_visible().unwrap_or(false) {
                q.hide().map_err(|e| e.to_string())?;
            } else {
                q.show().map_err(|e| e.to_string())?;
                q.set_focus().map_err(|e| e.to_string())?;
                let _ = q.emit("quick-panel-shown", ());
            }
        }
        return Ok(());
    }
    toggle_notepad(app).await
}

#[tauri::command]
async fn open_full_panel(app: tauri::AppHandle) -> Result<(), String> {
    expand_panel(app).await
}

#[tauri::command]
async fn fab_click(app: tauri::AppHandle) -> Result<(), String> {
    toggle_quick_panel(app).await
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
                let pet_w = 200.0 * scale;
                let pet_h = 200.0 * scale;
                let margin = 2.0 * scale;
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
            get_visible_windows,
            show_settings,
            toggle_notepad,
            update_quick_panel_position,
            toggle_quick_panel,
            open_full_panel,
            fab_click,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
