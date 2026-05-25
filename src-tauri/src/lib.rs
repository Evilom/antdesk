use std::sync::{Mutex, OnceLock};
use tauri::Manager;

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
            quick.hide().map_err(|e| e.to_string())?;
            return Ok(());
        }
        // Position near FAB and show — FAB stays visible
        position_quick_near_fab_inner(&app)?;
        quick.show().map_err(|e| e.to_string())?;
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
    let fab_size = 64.0;
    let quick_w = 260.0;
    let quick_h = 360.0;
    let gap = 36.0; // Enough gap so FAB is never covered

    // Get actual screen bounds
    let (screen_w, screen_h) = if let Some(monitor) = fab.current_monitor().ok().flatten() {
        let size = monitor.size();
        let scale = monitor.scale_factor();
        (size.width as f64 / scale, size.height as f64 / scale)
    } else {
        (1920.0, 1080.0)
    };

    // Try left of FAB first (most natural — panel opens like a drawer)
    let mut x = fab_x - quick_w - gap;
    let mut y = fab_y + fab_size - quick_h; // bottom-aligned with FAB

    // If not enough space on left, try right
    if x < 4.0 {
        x = fab_x + fab_size + gap;
    }

    // If neither side works, position above
    if x + quick_w > screen_w - 4.0 {
        x = fab_x + fab_size - quick_w;
        y = fab_y - quick_h - gap;
    }

    // If above doesn't fit, go below
    if y < 4.0 {
        y = fab_y + fab_size + gap;
    }

    // Clamp to screen
    if x < 4.0 { x = 4.0; }
    if x + quick_w > screen_w - 4.0 { x = screen_w - quick_w - 4.0; }
    if y < 4.0 { y = 4.0; }
    if y + quick_h > screen_h - 4.0 { y = screen_h - quick_h - 4.0; }

    let pos = tauri::Position::Physical(tauri::PhysicalPosition::new(
        x as i32,
        y as i32,
    ));
    quick.set_position(pos).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn open_full_panel(app: tauri::AppHandle) -> Result<(), String> {
    // Hide quick panel
    if let Some(quick) = app.get_webview_window("quick") {
        let _ = quick.hide();
    }
    // Show main panel
    expand_panel(app).await
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
            quit_app,
            show_fab,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
