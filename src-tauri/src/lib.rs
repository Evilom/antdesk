use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use serde::{Deserialize, Serialize};

static TOKEN_CACHE: Mutex<Option<String>> = Mutex::new(None);

#[derive(Debug, Serialize)]
struct ProxyRequest {
    platform: String,
}

#[derive(Debug, Deserialize)]
struct ProxyResponse {
    ret: i32,
    data: Option<ProxyData>,
}

#[derive(Debug, Deserialize)]
struct ProxyData {
    resp: Option<RespData>,
}

#[derive(Debug, Deserialize)]
struct RespData {
    access_token: Option<String>,
}

#[tauri::command]
async fn get_notion_token() -> Result<String, String> {
    // 先检查缓存
    {
        let cache = TOKEN_CACHE.lock().map_err(|e| e.to_string())?;
        if let Some(ref t) = *cache {
            return Ok(t.clone());
        }
    }

    // 通过本地 QClaw auth gateway 获取 Notion token
    let base_url = std::env::var("QCLAW_AUTH_URL")
        .unwrap_or_else(|_| "http://localhost:19000".to_string());

    let client = reqwest::Client::new();
    let proxy_url = format!("{}/proxy/api", base_url);
    let remote_url = "https://jprx.m.qq.com/data/4164/forward";

    let body = ProxyRequest {
        platform: "notion".to_string(),
    };

    let resp = client
        .post(&proxy_url)
        .header("Remote-URL", remote_url)
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Auth gateway 返回错误: {}", resp.status()));
    }

    let data: ProxyResponse = resp
        .json()
        .await
        .map_err(|e| format!("响应解析失败: {}", e))?;

    if data.ret != 0 {
        return Err(format!("Auth gateway ret={}，请检查 Notion 是否已授权", data.ret));
    }

    let token = data.data
        .and_then(|d| d.resp)
        .and_then(|r| r.access_token)
        .ok_or_else(|| "未获取到 access_token，请先在 QClaw 集成面板完成 Notion 授权".to_string())?;

    if let Ok(mut cache) = TOKEN_CACHE.lock() {
        *cache = Some(token.clone());
    }

    Ok(token)
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
    // 直接访问 Notion API（不走代理）
    let notion_api_url = format!("https://api.notion.com{}", path);

    let client = reqwest::Client::new();

    let mut req = match method.to_uppercase().as_str() {
        "POST" => client.post(&notion_api_url),
        "PATCH" => client.patch(&notion_api_url),
        "DELETE" => client.delete(&notion_api_url),
        "GET" => client.get(&notion_api_url),
        _ => client.get(&notion_api_url),
    };

    req = req
        .header("Authorization", format!("Bearer {}", token))
        .header("Notion-Version", "2025-09-03")
        .header("Content-Type", "application/json");

    if let Some(b) = body {
        req = req.body(b);
    }

    let resp = req
        .timeout(std::time::Duration::from_secs(30))
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
async fn window_close(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.close().map_err(|e| e.to_string())?;
    }
    std::process::exit(0);
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
