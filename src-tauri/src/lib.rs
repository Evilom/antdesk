use std::sync::Mutex;
use tauri::{AppHandle, Manager};

static TOKEN_CACHE: Mutex<Option<String>> = Mutex::new(None);

#[tauri::command]
async fn get_notion_token() -> Result<String, String> {
    // 先检查缓存
    {
        let cache = TOKEN_CACHE.lock().map_err(|e| e.to_string())?;
        if let Some(ref t) = *cache {
            return Ok(t.clone());
        }
    }

    // 直接从环境变量或配置读取 Notion token（不走 Auth Gateway）
    let token = std::env::var("NOTION_TOKEN")
        .unwrap_or_else(|_| "ntn_z7420851287aTgqYKcfYqocoVHHLmNadxKn2WHcZTFp8hv".to_string());

    if token.is_empty() {
        return Err("未配置 Notion Token，请设置环境变量 NOTION_TOKEN 或在设置页填写".to_string());
    }

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
    let notion_api_url = format!("https://api.notion.com{}", path);
    let client = reqwest::Client::new();

    // 直接访问 Notion API（Mac mini 可直连，无需代理）
    let mut req = match method.to_uppercase().as_str() {
        "POST" => client.post(&notion_api_url),
        "PATCH" => client.patch(&notion_api_url),
        "DELETE" => client.delete(&notion_api_url),
        "GET" => client.get(&notion_api_url),
        _ => client.get(&notion_api_url),
    };

    req = req
        .header("Authorization", format!("Bearer {}", token))
        .header("Notion-Version", "2022-06-28")
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
    // 收起主面板，显示 FAB 按钮（而不是退出应用）
    collapse_panel(app).await
}

#[tauri::command]
async fn window_hide(app: AppHandle) -> Result<(), String> {
    collapse_panel(app).await
}

#[tauri::command]
async fn is_maximized(window: tauri::Window) -> Result<bool, String> {
    window.is_maximized().map_err(|e| e.to_string())
}

/// 展开主面板（从 FAB 模式切换到面板模式）
/// FAB 窗口始终保持可见，作为悬浮入口
#[tauri::command]
async fn expand_panel(app: AppHandle) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        main.show().map_err(|e| e.to_string())?;
        main.unminimize().map_err(|e| e.to_string())?;
        main.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 收起主面板（从面板模式切换回 FAB 模式）
/// FAB 窗口始终保持可见，这里只隐藏主窗口
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

            // 主面板默认置顶（FAB 不置顶，macOS 按打开顺序决定层级，主窗口最后打开会在 FAB 之上）
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_always_on_top(true);
            }
            // FAB 窗口始终保持可见（由 tauri.conf.json 控制）

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
