use std::sync::Mutex;
use tauri::Manager;

#[derive(Default)]
struct AppState {
    notion_token: Mutex<Option<String>>,
}

const DEFAULT_NOTION_TOKEN: &str = "ntn_z7420851287aTgqYKcfYqocoVHHLmNadxKn2WHcZTFp8hv";

#[tauri::command]
fn get_notion_token(state: tauri::State<AppState>) -> String {
    let cached = state.notion_token.lock().unwrap();
    if let Some(ref token) = *cached {
        return token.clone();
    }
    drop(cached);

    let token = std::env::var("NOTION_TOKEN").unwrap_or_else(|_| DEFAULT_NOTION_TOKEN.to_string());
    let mut cached = state.notion_token.lock().unwrap();
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
    let client = reqwest::Client::new();

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
        req = req.body(b);
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    let text = resp.text().await.map_err(|e| e.to_string())?;
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
    expand_panel(app).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
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
            fab_click,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
