use std::{sync::Mutex, time::Duration};
use serde_json::{json, Value};

#[derive(Default)]
pub struct AssistantState {
    device_key: Mutex<String>,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(75))
        .build().map_err(|_| "无法初始化连接".into())
}

fn loopback(url: &reqwest::Url) -> bool {
    matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
}

fn gateway_url(base: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(base.trim()).map_err(|_| "请输入有效的语音服务地址")?;
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback(&url)))
        || !url.username().is_empty() || url.password().is_some()
        || url.query().is_some() || url.fragment().is_some() || url.path() != "/"
    {
        return Err("语音地址需要 HTTPS（本机可用 HTTP），且不含密钥、路径或参数".into());
    }
    Ok(url)
}

fn valid_voice_path(path: &str, method: &str) -> bool {
    match (method, path) {
        ("GET", "/v1/capabilities" | "/v1/realtime/sessions") |
        ("POST", "/v1/realtime/sessions") => true,
        ("GET" | "DELETE", _) => path.strip_prefix("/v1/realtime/sessions/")
            .is_some_and(|id| !id.is_empty() && id.len() <= 160 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')),
        ("POST", _) => path.strip_suffix("/renew")
            .is_some_and(|session| valid_voice_path(session, "DELETE") && session != "/v1/realtime/sessions"),
        _ => false,
    }
}

#[tauri::command]
pub fn set_voice_device_key(key: String, state: tauri::State<AssistantState>) -> Result<(), String> {
    let key = key.trim();
    if key.len() > 128 || key.chars().any(char::is_whitespace) {
        return Err("设备密钥格式不正确".into());
    }
    #[cfg(target_os = "macos")]
    if !key.is_empty() {
        security_framework::passwords::set_generic_password("com.antdesk.app.voice", "device-key", key.as_bytes())
            .map_err(|_| "无法保存到 macOS 钥匙串，请检查系统授权")?;
    }
    *state.device_key.lock().map_err(|_| "凭据暂不可用")? = key.to_owned();
    Ok(())
}

fn voice_key(state: &AssistantState) -> Result<String, String> {
    let current = state.device_key.lock().map_err(|_| "凭据暂不可用")?.clone();
    let mut key = if current.is_empty() { std::env::var("ANTDESK_VOICE_DEVICE_KEY").unwrap_or_default() } else { current };
    #[cfg(target_os = "macos")]
    if key.trim().is_empty() {
        if let Ok(saved)=security_framework::passwords::get_generic_password("com.antdesk.app.voice", "device-key") {
            key=String::from_utf8(saved).map_err(|_|"钥匙串凭据格式无效")?;
        }
    }
    if key.trim().is_empty() { return Err("请在设置中输入语音设备密钥".into()); }
    Ok(key.trim().to_owned())
}

#[tauri::command]
pub fn voice_key_ready(state: tauri::State<AssistantState>) -> bool {
    voice_key(&state).is_ok()
}

/// Bind this desktop to the already configured local gateway. Credentials stay native.
#[tauri::command]
pub async fn connect_local_voice(state: tauri::State<'_, AssistantState>) -> Result<Value, String> {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).map_err(|_| "无法定位本机配置")?;
    let config = std::env::var("ANTDESK_VOICE_CONFIG_FILE").map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from(home).join("projects/chatgpt-web-voice/.env"));
    let env = std::fs::read_to_string(config).map_err(|_| "未找到已部署的本机语音配置，请使用下方手动连接")?;
    let value = |name: &str| env.lines().find_map(|line| {
        let (key, value) = line.trim().strip_prefix("export ").unwrap_or(line.trim()).split_once('=')?;
        (key.trim() == name).then(|| value.trim().trim_matches(|c| c=='\'' || c=='"').to_string())
    });
    let port = value("VOICE_PORT").unwrap_or_else(||"6080".into()).parse::<u16>().map_err(|_| "本机语音端口配置无效")?;
    let base = format!("http://127.0.0.1:{port}");
    let client=client()?;
    if let Ok(key)=voice_key(&state) {
        if let Ok(response)=client.get(format!("{base}/v1/capabilities")).bearer_auth(key).timeout(Duration::from_secs(8)).send().await {
            if response.status().is_success() {return Ok(json!({"baseUrl":base,"ready":true}));}
        }
    }
    let admin=value("VOICE_AUTH_KEY").filter(|s|!s.is_empty()).ok_or("本机语音配置缺少管理凭据")?;
    let response=client.post(format!("{base}/v1/devices")).bearer_auth(&admin).json(&json!({"name":"AntDesk personal PM","max_sessions":1})).timeout(Duration::from_secs(10)).send().await
        .map_err(|_|"本机语音网关未启动，请检查服务")?;
    if !response.status().is_success(){return Err(format!("本机绑定失败（HTTP {}）",response.status().as_u16()));}
    let data:Value=response.json().await.map_err(|_|"本机网关返回无效数据")?;
    let key=data["api_key"].as_str().ok_or("网关未返回设备密钥")?;
    if let Err(error)=set_voice_device_key(key.into(),state) {
        if let Some(id)=data["id"].as_str().filter(|id| id.chars().all(|c|c.is_ascii_alphanumeric()||c=='_')) {
            let _=client.delete(format!("{base}/v1/devices/{id}")).bearer_auth(admin).timeout(Duration::from_secs(8)).send().await;
        }
        return Err(error);
    }
    Ok(json!({"baseUrl":base,"ready":true}))
}

#[tauri::command]
pub fn is_development_build() -> bool { cfg!(debug_assertions) }

#[tauri::command]
pub async fn voice_gateway_request(
    base_url: String, path: String, method: String, body: Option<Value>, timeout_ms: Option<u64>,
    state: tauri::State<'_, AssistantState>,
) -> Result<Value, String> {
    if !valid_voice_path(&path, &method) { return Err("不支持的语音操作".into()); }
    let url = gateway_url(&base_url)?.join(&path).map_err(|_| "语音地址无效")?;
    let key = voice_key(&state)?;
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "请求方法无效")?;
    let mut request = client()?.request(method, url).bearer_auth(key)
        .timeout(Duration::from_millis(timeout_ms.unwrap_or(75000).clamp(1000,75000)));
    if let Some(data) = body {
        if data.to_string().len() > 72000 { return Err("语音请求过大".into()); }
        request = request.json(&data);
    }
    let response = request.send().await.map_err(|_| "无法连接语音服务，请检查地址与网络")?;
    let status = response.status().as_u16();
    let payload = if status == 204 { Value::Null } else {
        response.json::<Value>().await.map_err(|_| "语音服务返回了无效数据")?
    };
    // Preserve status and retryability without logging or returning credentials.
    Ok(json!({ "status": status, "payload": payload }))
}

fn knowledge_url() -> Result<reqwest::Url, String> {
    let base = std::env::var("ANTDESK_KNOWLEDGE_URL").unwrap_or_else(|_| "http://127.0.0.1:8765".into());
    let url = gateway_url(&base)?;
    // The existing Hermes token must never be forwarded outside this computer.
    if !loopback(&url) { return Err("Hermes 知识连接只允许本机服务".into()); }
    Ok(url)
}

fn knowledge_token() -> Result<String, String> {
    if let Ok(value) = std::env::var("QMD_KB_TOKEN") {
        if !value.trim().is_empty() { return Ok(value.trim().into()); }
    }
    let path = match std::env::var("QMD_KB_TOKEN_FILE") {
        Ok(path) => std::path::PathBuf::from(path),
        Err(_) => std::path::PathBuf::from(std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).map_err(|_| "无法定位 Hermes 配置")?)
            .join(".hermes/services/qmd-kb-service/.token"),
    };
    let value = std::fs::read_to_string(path).map_err(|_| "未找到 Hermes 知识服务凭据，请配置 QMD_KB_TOKEN_FILE")?;
    if value.trim().is_empty() { return Err("Hermes 知识服务凭据为空".into()); }
    Ok(value.trim().into())
}

async fn knowledge_response(request: reqwest::RequestBuilder) -> Result<Value, String> {
    let response = request.timeout(Duration::from_secs(40)).send().await
        .map_err(|_| "Hermes 知识服务未连接，请检查本机 QMD 服务")?;
    if !response.status().is_success() {
        return Err(format!("知识检索失败（HTTP {}），请检查 QMD 服务与凭据", response.status().as_u16()));
    }
    let data = response.json::<Value>().await.map_err(|_| "知识服务返回了无效数据")?;
    if data.get("ok").and_then(Value::as_bool) != Some(true) { return Err("QMD 索引暂不可用".into()); }
    if data.get("parse_error").is_some() { return Err("QMD 检索结果无法解析".into()); }
    Ok(data)
}

#[tauri::command]
pub async fn knowledge_status() -> Result<Value, String> {
    let url = knowledge_url()?.join("health").map_err(|_| "知识服务地址无效")?;
    let data = knowledge_response(client()?.get(url)).await?;
    if data.get("service").and_then(Value::as_str) != Some("qmd-kb-service") {
        return Err("当前端口不是 Hermes QMD 知识服务".into());
    }
    Ok(json!({"ok": true, "collection": data["collection"], "status": data["qmd_status"], "authenticated": knowledge_token().is_ok()}))
}

pub async fn search(query: String, semantic: bool) -> Result<Value, String> {
    let query = query.trim();
    if query.is_empty() || query.chars().count() > 500 { return Err("请输入 1–500 字的知识检索问题".into()); }
    let url = knowledge_url()?.join(if semantic { "query" } else { "search" }).map_err(|_| "知识服务地址无效")?;
    let result = knowledge_response(client()?.post(url).bearer_auth(knowledge_token()?)
        .json(&json!({"query": query, "n": 5, "no_rerank": true}))).await?;
    if !result["results"].is_array() { return Err("QMD 未返回有效的检索列表".into()); }
    Ok(json!({"results": result["results"], "elapsed_ms": result["elapsed_ms"]}))
}

#[tauri::command]
pub async fn search_hermes_knowledge(query: String, semantic: Option<bool>) -> Result<Value, String> {
    search(query, semantic.unwrap_or(false)).await
}

#[tauri::command]
pub async fn read_hermes_document(file: String) -> Result<Value, String> {
    if !file.starts_with("qmd://wiki/") || file.contains("..") || file.len() > 1000 {
        return Err("只支持知识库检索返回的文档来源".into());
    }
    let mut url = knowledge_url()?.join("doc").map_err(|_| "知识服务地址无效")?;
    url.query_pairs_mut().append_pair("file", &file).append_pair("lines", "120");
    let result = knowledge_response(client()?.get(url).bearer_auth(knowledge_token()?)).await?;
    Ok(json!({"file": file, "content": result["stdout"]}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gateway_rejects_insecure_or_credential_urls() {
        assert!(gateway_url("http://127.0.0.1:6080").is_ok());
        assert!(gateway_url("https://voice.example.com").is_ok());
        for url in ["http://voice.example.com", "https://secret@example.com", "file:///tmp/key", "https://example.com/?key=x", "https://example.com/path"] {
            assert!(gateway_url(url).is_err(), "{url}");
        }
    }
    #[test]
    fn voice_bridge_cannot_manage_devices_or_escape_paths() {
        assert!(valid_voice_path("/v1/realtime/sessions/abc-123", "DELETE"));
        assert!(valid_voice_path("/v1/realtime/sessions/abc-123/renew", "POST"));
        assert!(!valid_voice_path("/v1/realtime/sessions/../renew", "POST"));
        assert!(!valid_voice_path("/v1/realtime/sessions/renew", "POST"));
        assert!(!valid_voice_path("/v1/devices/abc/renew", "POST"));
        assert!(!valid_voice_path("/v1/devices", "POST"));
        assert!(!valid_voice_path("/v1/realtime/sessions/../devices", "GET"));
        assert!(!valid_voice_path("/v1/realtime/sessions/x?key=x", "GET"));
    }
    #[tokio::test]
    #[ignore = "Requires existing local Hermes QMD service; read only"]
    async fn live_knowledge_search() {
        let result = search("AntDesk".into(), false).await.unwrap();
        assert!(!result["results"].as_array().unwrap().is_empty());
        assert!(result["results"][0]["file"].as_str().unwrap().starts_with("qmd://wiki/"));
    }
}
