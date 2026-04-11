use tauri::{Manager, AppHandle};
use std::sync::Mutex;

static TOKEN_CACHE: Mutex<Option<String>> = Mutex::new(None);

#[tauri::command]
async fn get_notion_token() -> Result<String, String> {
    // 先检查缓存
    if let Ok(cache) = TOKEN_CACHE.lock() {
        if let Some(ref t) = *cache {
            return Ok(t.clone());
        }
    }

    // 尝试从 QClaw 本地代理获取
    let client = reqwest::Client::new();
    if let Ok(resp) = client
        .get("http://localhost:19000/api/v1/notion/token")
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
    {
        if resp.status().is_success() {
            if let Ok(text) = resp.text().await {
                let trimmed = text.trim().to_string();
                if !trimmed.is_empty() {
                    if let Ok(mut cache) = TOKEN_CACHE.lock() {
                        *cache = Some(trimmed.clone());
                    }
                    return Ok(trimmed);
                }
            }
        }
    }

    Err("无法获取 Notion Token，请检查 QClaw 是否运行".to_string())
}

#[tauri::command]
async fn clear_token_cache() -> Result<(), String> {
    if let Ok(mut cache) = TOKEN_CACHE.lock() {
        *cache = None;
    }
    Ok(())
}

#[tauri::command]
async fn fetch_notion(path: String, method: String, body: Option<String>, token: String) -> Result<String, String> {
    let client = reqwest::Client::new();
    let mut req = match method.to_uppercase().as_str() {
        "POST" => client.post(format!("https://api.notion.com{}", path)),
        "PATCH" => client.patch(format!("https://api.notion.com{}", path)),
        "DELETE" => client.delete(format!("https://api.notion.com{}", path)),
        _ => client.get(format!("https://api.notion.com{}", path)),
    };
    
    req = req
        .header("Authorization", format!("Bearer {}", token))
        .header("Notion-Version", "2025-09-03")
        .header("Content-Type", "application/json");
    
    if let Some(b) = body {
        req = req.body(b);
    }
    
    let resp = req
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;
    
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("读取失败: {}", e))?;
    
    if !status.is_success() {
        return Err(format!("Notion API 错误 {}: {}", status.as_u16(), &text[..text.len().min(200)]));
    }
    
    Ok(text)
}

#[tauri::command]
async fn window_minimize(window: tauri::Window) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
async fn window_maximize(window: tauri::Window) -> Result<(), String> {
    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

#[tauri::command]
async fn window_close(window: tauri::Window) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
async fn window_hide(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(|e| e.to_string())
    } else {
        Err("窗口未找到".to_string())
    }
}

#[tauri::command]
async fn is_maximized(window: tauri::Window) -> Result<bool, String> {
    window.is_maximized().map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_notion_token,
            clear_token_cache,
            fetch_notion,
            window_minimize,
            window_maximize,
            window_close,
            window_hide,
            is_maximized,
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_always_on_top(true);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
