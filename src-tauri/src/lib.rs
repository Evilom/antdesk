use std::sync::Mutex;
use tauri::{AppHandle, Manager, PhysicalPosition};
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
        .unwrap_or_else(|_| "http://evilom.top:6041".to_string());

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
    // 数据来源模式：
    // - "direct"：Mac mini 直连 Notion API
    // - "tunnel"：通过 evilom.top:6041 隧道转发（需 Mac mini 在家开着 frpc）
    let mode = std::env::var("ANTDESK_DATA_MODE")
        .unwrap_or_else(|_| "tunnel".to_string());

    let notion_api_url = format!("https://api.notion.com{}", path);

    let client = reqwest::Client::new();

    if mode == "tunnel" {
        // 通过远端隧道走 QClaw Auth Gateway 的 proxy/api 端点
        let tunnel_url = std::env::var("ANTDESK_TUNNEL_URL")
            .unwrap_or_else(|_| "http://evilom.top:6041".to_string());

        let proxy_url = format!("{}/proxy/api", tunnel_url);

        let mut req = match method.to_uppercase().as_str() {
            "POST" => client.post(&proxy_url),
            "PATCH" => client.patch(&proxy_url),
            "DELETE" => client.delete(&proxy_url),
            "GET" => client.get(&proxy_url),
            _ => client.get(&proxy_url),
        };

        req = req
            .header("Remote-URL", &notion_api_url)
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
            .map_err(|e| format!("隧道请求失败: {}", e))?;

        let status = resp.status();
        let text = resp.text().await.map_err(|e| format!("读取失败: {}", e))?;

        if !status.is_success() {
            return Err(format!("代理返回错误 {}: {}", status.as_u16(), &text[..text.len().min(300)]));
        }

        Ok(text)
    } else {
        // 直接访问 Notion API
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

/// 展开主面板（从 FAB 模式切换到面板模式）
#[tauri::command]
async fn expand_panel(app: AppHandle) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        main.show().map_err(|e| e.to_string())?;
        main.unminimize().map_err(|e| e.to_string())?;
        // 重新设置置顶，确保在 FAB 之上
        main.set_always_on_top(true).map_err(|e| e.to_string())?;
        main.set_focus().map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("主窗口未找到".to_string())
    }
}

/// 收起主面板（从面板模式切换回 FAB 模式）
#[tauri::command]
async fn collapse_panel(app: AppHandle) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        main.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// FAB 点击：展开主面板
#[tauri::command]
async fn fab_click(app: AppHandle) -> Result<(), String> {
    expand_panel(app).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // 设置托盘图标：单击显示/隐藏主面板
            use tauri::tray::TrayIconBuilder;
            use tauri::menu::{MenuBuilder, MenuItemBuilder};

            let show_item = MenuItemBuilder::with_id("show", "显示 AntDesk").build(app)?;
            let hide_item = MenuItemBuilder::with_id("hide", "隐藏面板").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "退出").build(app)?;

            let menu = MenuBuilder::new(app)
                .item(&show_item)
                .item(&hide_item)
                .separator()
                .item(&quit_item)
                .build()?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().unwrap())
                .menu(&menu)
                .tooltip("AntDesk 🐜 — 点击展开")
                .on_menu_event(move |app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(main) = app.get_webview_window("main") {
                                let _ = main.show();
                                let _ = main.unminimize();
                                let _ = main.set_focus();
                            }
                        }
                        "hide" => {
                            if let Some(main) = app.get_webview_window("main") {
                                let _ = main.hide();
                            }
                        }
                        "quit" => {
                            std::process::exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    use tauri::tray::TrayIconEvent;
                    if let TrayIconEvent::Click { .. } = event {
                        let app = tray.app_handle();
                        if let Some(main) = app.get_webview_window("main") {
                            if main.is_visible().unwrap_or(false) {
                                let _ = main.hide();
                            } else {
                                let _ = main.show();
                                let _ = main.unminimize();
                                let _ = main.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            // 主面板默认置顶
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_always_on_top(true);
            }

            // 动态设置 FAB 窗口位置到屏幕右下角
            if let Some(fab) = app.get_webview_window("fab") {
                if let Ok(monitor) = fab.current_monitor() {
                    if let Some(monitor) = monitor {
                        let screen_size = monitor.size();
                        let fab_size = fab.outer_size().unwrap_or(tauri::PhysicalSize::new(64, 64));
                        // 计算右下角位置，留出 20px 边距
                        let x = (screen_size.width as i32) - (fab_size.width as i32) - 20;
                        let y = (screen_size.height as i32) - (fab_size.height as i32) - 20;
                        let _ = fab.set_position(tauri::PhysicalPosition::new(x, y));
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_notion_token,
            clear_token_cache,
            fetch_notion,
            window_minimize,
            window_maximize,
            window_close,
            window_hide,
            is_maximized,
            expand_panel,
            collapse_panel,
            fab_click,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
