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
            cached
                .clone()
                .unwrap_or_else(|| DEFAULT_NOTION_TOKEN.to_string())
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

// Window management commands

#[tauri::command]
async fn window_minimize(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.minimize().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn window_maximize(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_maximized().unwrap_or(false) {
            window.unmaximize().map_err(|e| e.to_string())?;
        } else {
            window.maximize().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn window_close(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(|e| e.to_string())?;
    }
    if let Some(fab) = app.get_webview_window("fab") {
        fab.show().map_err(|e| e.to_string())?;
        fab.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn is_maximized(app: tauri::AppHandle) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window("main") {
        return window.is_maximized().map_err(|e| e.to_string());
    }
    Ok(false)
}

#[tauri::command]
async fn expand_panel(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(fab) = app.get_webview_window("fab") {
        fab.hide().map_err(|e| e.to_string())?;
    }
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn collapse_panel(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(|e| e.to_string())?;
    }
    if let Some(fab) = app.get_webview_window("fab") {
        fab.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn fab_click(app: tauri::AppHandle) -> Result<(), String> {
    toggle_quick_panel(app).await
}

#[tauri::command]
async fn get_fab_position(app: tauri::AppHandle) -> Result<(f64, f64), String> {
    if let Some(fab) = app.get_webview_window("fab") {
        let pos = fab.outer_position().map_err(|e| e.to_string())?;
        Ok((pos.x as f64, pos.y as f64))
    } else {
        Err("FAB window not found".to_string())
    }
}

#[tauri::command]
async fn set_fab_position(app: tauri::AppHandle, x: f64, y: f64) -> Result<(), String> {
    if let Some(fab) = app.get_webview_window("fab") {
        let pos = tauri::Position::Physical(tauri::PhysicalPosition::new(x as i32, y as i32));
        fab.set_position(pos).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn show_fab_context_menu(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    let handle = app.clone();

    let show_item = MenuItem::with_id(&handle, "fab_show", "Show Panel", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let separator = PredefinedMenuItem::separator(&handle).map_err(|e| e.to_string())?;
    let quit_item = MenuItem::with_id(&handle, "fab_quit", "Quit", true, None::<&str>)
        .map_err(|e| e.to_string())?;

    let menu = Menu::with_items(&handle, &[&show_item, &separator, &quit_item])
        .map_err(|e| e.to_string())?;

    if let Some(fab) = handle.get_webview_window("fab") {
        fab.popup_menu(&menu).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
async fn fab_drag(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(fab) = app.get_webview_window("fab") {
        fab.start_dragging().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn show_settings(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(fab) = app.get_webview_window("fab") {
        fab.hide().map_err(|e| e.to_string())?;
    }
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn toggle_panel(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        if main.is_visible().unwrap_or(false) {
            collapse_panel(app).await
        } else {
            expand_panel(app).await
        }
    } else {
        expand_panel(app).await
    }
}

#[tauri::command]
async fn get_pending_count(state: tauri::State<'_, AppState>) -> Result<u32, String> {
    let token = {
        let cached = state.notion_token.lock().unwrap();
        cached
            .clone()
            .unwrap_or_else(|| DEFAULT_NOTION_TOKEN.to_string())
    };

    let body = serde_json::json!({
        "filter": {
            "property": "Status",
            "checkbox": { "equals": false }
        },
        "page_size": 100
    })
    .to_string();

    let url = "https://api.notion.com/v1/databases/2d51ba51-3457-8125-9d4c-f28ffa2fff14/query";
    let client = http_client();
    let resp = client
        .post(url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Notion-Version", "2022-06-28")
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let text = resp.text().await.map_err(|e| e.to_string())?;
        return Err(format!("Notion API error: {}", text));
    }

    let data: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let count = data["results"].as_array().map(|a| a.len() as u32).unwrap_or(0);
    Ok(count)
}

#[tauri::command]
async fn toggle_quick_panel(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(quick) = app.get_webview_window("quick") {
        if quick.is_visible().unwrap_or(false) {
            // Emit close event — frontend handles exit animation then hides
            let _ = app.emit("close-quick-panel", ());
            return Ok(());
        }
        // Position near FAB and show — FAB stays visible
        position_quick_near_fab_inner(&app)?;
        quick.show().map_err(|e| e.to_string())?;
        // Quick panel below FAB in z-order — FAB covers panel corner
        let _ = quick.set_always_on_top(false);
        quick.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn position_quick_near_fab_inner(app: &tauri::AppHandle) -> Result<(), String> {
    let fab = app
        .get_webview_window("fab")
        .ok_or("FAB window not found")?;
    let quick = app
        .get_webview_window("quick")
        .ok_or("Quick window not found")?;

    let fab_pos = fab.outer_position().map_err(|e| e.to_string())?;
    let fab_x = fab_pos.x as f64;
    let fab_y = fab_pos.y as f64;

    let monitor = fab.current_monitor().ok().flatten();
    let scale = monitor.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);

    // FAB is 200x200 window, button is 48x48 centered
    let fab_center_x = fab_x + 100.0 * scale;
    let dot_top = fab_y + 76.0 * scale;      // 100 - 24 (button radius)
    let dot_bottom = fab_y + 124.0 * scale;   // 100 + 24

    // Panel edge aligns to FAB center — no gap, grow from center
    let quick_w = 260.0 * scale;
    // Use actual window size if available, fallback to 200
    let quick_h = quick
        .outer_size()
        .map(|s| s.height as f64)
        .unwrap_or(200.0 * scale);
    let margin = 8.0 * scale;

    // Monitor bounds
    let (mon_left, mon_top, mon_right, mon_bottom) = if let Some(ref m) = monitor {
        let p = m.position();
        let s = m.size();
        (
            p.x as f64,
            p.y as f64,
            p.x as f64 + s.width as f64,
            p.y as f64 + s.height as f64,
        )
    } else {
        (0.0, 0.0, 1920.0 * scale, 1080.0 * scale)
    };

    // ── Step 1: Decide above or below ──
    // If FAB is in the lower half of the screen → open upward (above)
    // If FAB is in the upper half → open downward (below)
    let screen_mid_y = (mon_top + mon_bottom) / 2.0;
    let fab_center_y = (dot_top + dot_bottom) / 2.0;
    let mut is_above = fab_center_y > screen_mid_y;

    // Panel edge sits exactly at FAB center — no gap, grows outward
    let mut y = if is_above {
        fab_center_y - quick_h
    } else {
        fab_center_y
    };

    // If preferred direction doesn't fit, flip
    if is_above && y < mon_top + margin {
        y = fab_center_y;
        is_above = false;
    } else if !is_above && y + quick_h > mon_bottom - margin {
        y = fab_center_y - quick_h;
        is_above = true;
    }

    // Final safety: clamp to screen
    if y < mon_top + margin {
        y = mon_top + margin;
        is_above = false;
    }

    // ── Step 2: Horizontally center on FAB, then shift if off-edge ──
    let mut x = fab_center_x - quick_w / 2.0;

    // If panel goes off left edge, shift right
    if x < mon_left + margin {
        x = mon_left + margin;
    }
    // If panel goes off right edge, shift left
    if x + quick_w > mon_right - margin {
        x = mon_right - quick_w - margin;
    }

    // Final clamp
    if x < mon_left + margin { x = mon_left + margin; }
    if y < mon_top + margin { y = mon_top + margin; }
    if y + quick_h > mon_bottom - margin { y = mon_bottom - quick_h - margin; }

    let pos = tauri::Position::Physical(tauri::PhysicalPosition::new(x as i32, y as i32));
    quick.set_position(pos).map_err(|e| e.to_string())?;

    // Emit direction so frontend can reverse layout
    let _ = app.emit("quick-panel-direction", if is_above { "above" } else { "below" });

    Ok(())
}

#[tauri::command]
async fn update_quick_panel_position(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(quick) = app.get_webview_window("quick") {
        if quick.is_visible().unwrap_or(false) {
            position_quick_near_fab_inner(&app)?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn open_full_panel(app: tauri::AppHandle) -> Result<(), String> {
    // Hide quick panel (no animation needed — switching to main)
    if let Some(quick) = app.get_webview_window("quick") {
        let _ = quick.hide();
    }
    // Show main panel
    expand_panel(app).await
}

// ── Notepad panel commands ──

fn position_notepad_near_pet_inner(app: &tauri::AppHandle) -> Result<(), String> {
    let pet = app
        .get_webview_window("pet")
        .ok_or("Pet window not found")?;
    let notepad = app
        .get_webview_window("notepad")
        .ok_or("Notepad window not found")?;

    let pet_pos = pet.outer_position().map_err(|e| e.to_string())?;
    let pet_size = pet.outer_size().map_err(|e| e.to_string())?;
    let monitor = pet.current_monitor().ok().flatten();
    let scale = monitor.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);

    let notepad_w = 280.0 * scale;
    let notepad_h = 320.0 * scale;
    let margin = 8.0 * scale;

    let pet_x = pet_pos.x as f64;
    let pet_y = pet_pos.y as f64;
    let pet_w = pet_size.width as f64;
    let pet_h = pet_size.height as f64;

    // Monitor bounds
    let (mon_left, mon_top, mon_right, mon_bottom) = if let Some(ref m) = monitor {
        let p = m.position();
        let s = m.size();
        (
            p.x as f64,
            p.y as f64,
            p.x as f64 + s.width as f64,
            p.y as f64 + s.height as f64,
        )
    } else {
        (0.0, 0.0, 1920.0 * scale, 1080.0 * scale)
    };

    // Try left of pet first, then right, then above
    let mut x = pet_x - notepad_w - margin;
    let mut y = pet_y + pet_h / 2.0 - notepad_h / 2.0;

    // If off left edge, try right side
    if x < mon_left + margin {
        x = pet_x + pet_w + margin;
    }
    // If off right edge, try above
    if x + notepad_w > mon_right - margin {
        x = pet_x + pet_w / 2.0 - notepad_w / 2.0;
        y = pet_y - notepad_h - margin;
    }
    // Clamp vertically
    if y < mon_top + margin {
        y = mon_top + margin;
    }
    if y + notepad_h > mon_bottom - margin {
        y = mon_bottom - notepad_h - margin;
    }
    // Clamp horizontally
    if x < mon_left + margin {
        x = mon_left + margin;
    }
    if x + notepad_w > mon_right - margin {
        x = mon_right - notepad_w - margin;
    }

    let pos = tauri::Position::Physical(tauri::PhysicalPosition::new(x as i32, y as i32));
    notepad.set_position(pos).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn toggle_notepad(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(notepad) = app.get_webview_window("notepad") {
        if notepad.is_visible().unwrap_or(false) {
            let _ = notepad.hide();
        } else {
            position_notepad_near_pet_inner(&app)?;
            let _ = notepad.show();
            let _ = notepad.set_focus();
            // Emit event so frontend can refresh data
            let _ = app.emit("notepad-shown", ());
        }
    }
    Ok(())
}

#[tauri::command]
async fn quit_app(app: tauri::AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

#[tauri::command]
async fn show_fab(app: tauri::AppHandle) -> Result<(), String> {
    // FAB is always visible, this just ensures it
    if let Some(fab) = app.get_webview_window("fab") {
        fab.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Pet window commands ──

#[tauri::command]
async fn pet_drag(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(pet) = app.get_webview_window("pet") {
        pet.start_dragging().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn pet_click(app: tauri::AppHandle) -> Result<(), String> {
    toggle_panel(app).await
}

#[tauri::command]
async fn show_pet(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(pet) = app.get_webview_window("pet") {
        pet.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn hide_pet(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(pet) = app.get_webview_window("pet") {
        pet.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Get screen available bounds (excluding Dock/menu bar) for the pet's current monitor.
/// Returns { x, y, width, height } in physical pixels.
#[tauri::command]
async fn get_screen_bounds(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let pet = app
        .get_webview_window("pet")
        .ok_or("Pet window not found")?;

    let monitor = pet.current_monitor().ok().flatten()
        .ok_or("No monitor found")?;

    let scale = monitor.scale_factor();
    let pos = monitor.position();
    let size = monitor.size();

    // Full monitor bounds in physical pixels
    let mon_x = pos.x as f64;
    let mon_y = pos.y as f64;
    let mon_w = size.width as f64;
    let mon_h = size.height as f64;

    // macOS: estimate safe area (menu bar ~25pt, Dock ~65pt)
    // Available = monitor minus top menu bar minus bottom dock
    let menu_bar_h = 25.0 * scale;
    let dock_h = 65.0 * scale;

    let avail_x = mon_x;
    let avail_y = mon_y + menu_bar_h;
    let avail_w = mon_w;
    let avail_h = mon_h - menu_bar_h - dock_h;

    Ok(serde_json::json!({
        "x": avail_x,
        "y": avail_y,
        "width": avail_w,
        "height": avail_h,
        "scale": scale,
    }))
}

const PET_SIZES: &[(&str, f64, f64)] = &[
    ("tiny", 120.0, 120.0),
    ("small", 200.0, 200.0),
    ("medium", 260.0, 260.0),
    ("large", 360.0, 360.0),
];

#[tauri::command]
async fn set_pet_size(app: tauri::AppHandle, size: String) -> Result<(), String> {
    let pet = app
        .get_webview_window("pet")
        .ok_or("Pet window not found")?;

    let (_, w, h) = PET_SIZES
        .iter()
        .find(|(name, _, _)| *name == size.as_str())
        .copied()
        .unwrap_or(("medium", 260.0, 260.0));

    let scale = pet
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);

    let logical = tauri::Size::Logical(tauri::LogicalSize::new(w, h));
    pet.set_size(logical).map_err(|e| e.to_string())?;

    // Reposition to keep bottom-right anchored
    position_pet_bottom_right_inner(&app, w * scale, h * scale)?;

    Ok(())
}

/// Position pet window at bottom-right of current monitor
fn position_pet_bottom_right_inner(
    app: &tauri::AppHandle,
    pet_w: f64,
    pet_h: f64,
) -> Result<(), String> {
    let pet = app
        .get_webview_window("pet")
        .ok_or("Pet window not found")?;

    let monitor = pet.current_monitor().ok().flatten();
    let scale = monitor.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);

    let (mon_right, mon_bottom) = if let Some(ref m) = monitor {
        let p = m.position();
        let s = m.size();
        (p.x as f64 + s.width as f64, p.y as f64 + s.height as f64)
    } else {
        (1920.0 * scale, 1080.0 * scale)
    };

    let margin = 24.0 * scale;
    let x = mon_right - pet_w - margin;
    let y = mon_bottom - pet_h - margin;

    let pos = tauri::Position::Physical(tauri::PhysicalPosition::new(x as i32, y as i32));
    pet.set_position(pos).map_err(|e| e.to_string())?;

    Ok(())
}

fn setup_tray(app: &tauri::App) {
    use tauri::image::Image;
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::TrayIconBuilder;

    let handle = app.handle().clone();

    let show_item = MenuItem::with_id(&handle, "show", "Show Panel", true, None::<&str>)
        .expect("failed to create show menu item");
    let settings_item =
        MenuItem::with_id(&handle, "settings", "Settings", true, None::<&str>)
            .expect("failed to create settings menu item");
    let separator =
        PredefinedMenuItem::separator(&handle).expect("failed to create separator");
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
                "quit" => {
                    app.exit(0);
                }
                "show" => {
                    let app_handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = expand_panel(app_handle).await;
                    });
                }
                "settings" => {
                    let app_handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = show_settings(app_handle).await;
                    });
                }
                _ => {}
            }
        })
        .build(&handle)
        .expect("failed to create tray icon");
}

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

            // Position pet window at bottom-right of primary monitor
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

            let app_handle = app.handle().clone();
            app_handle.on_menu_event(move |app, event| {
                match event.id().as_ref() {
                    "fab_show" => {
                        let app_handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = expand_panel(app_handle).await;
                        });
                    }
                    "fab_quit" => {
                        app.exit(0);
                    }
                    _ => {}
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_notion_token,
            clear_token_cache,
            fetch_notion,
            window_minimize,
            window_maximize,
            window_close,
            is_maximized,
            expand_panel,
            collapse_panel,
            toggle_quick_panel,
            open_full_panel,
            fab_click,
            fab_drag,
            get_fab_position,
            set_fab_position,
            show_fab_context_menu,
            show_settings,
            toggle_panel,
            get_pending_count,
            toggle_notepad,
            quit_app,
            show_fab,
            update_quick_panel_position,
            pet_drag,
            pet_click,
            show_pet,
            hide_pet,
            set_pet_size,
            get_screen_bounds,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
