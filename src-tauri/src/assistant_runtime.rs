//! Private, loopback-only desktop gateway to the installed assistant runtimes.
//! The browser supplies a small allowlisted route, never an origin or bridge credential.
use reqwest::{Method, Url};
use serde::Deserialize;
use serde_json::Value;
use std::{path::{Path, PathBuf}, process::Stdio, sync::OnceLock, time::Duration};
use tokio::sync::Mutex;

pub(crate) const ENDPOINT: &str = "http://127.0.0.1:47631";
const MAX_RESPONSE: usize = 4 * 1024 * 1024;
const MAX_BODY: usize = 128 * 1024;
static START_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeRequest {
    pub method: String,
    pub path: String,
    pub body: Option<Value>,
}

fn identifier(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && value.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.' | b'~'))
        && value != "." && value != ".."
}
fn provider(value: &str) -> bool { matches!(value, "grok-direct" | "dots-direct" | "muse-code" | "deepseek-harness" | "muse-personal" | "notion-web") }

/// Parse before joining: URL normalization must not turn a disallowed route into an allowed one.
fn route(request: &RuntimeRequest) -> Result<(Method, Url), String> {
    if request.path.len() > 2048 || !request.path.starts_with("/api/runtime/") ||
        request.path.contains(['\\', '#']) || request.path.chars().any(char::is_control) {
        return Err("不允许的本机助理管理路径。".into());
    }
    let (path, query) = request.path.split_once('?').map_or((request.path.as_str(), None), |(p, q)| (p, Some(q)));
    if path.contains('%') { return Err("本机管理路径不能包含编码路径。".into()); }
    let segments: Vec<_> = path.split('/').collect();
    let expected = match segments.as_slice() {
        ["", "api", "runtime", "providers"] => "GET",
        ["", "api", "runtime", "providers", id, "agents" | "sessions"] if provider(id) => "GET",
        ["", "api", "runtime", "providers", id, "login", "status"] if provider(id) => "GET",
        ["", "api", "runtime", "providers", id, "configure" | "logout"] if provider(id) => "POST",
        ["", "api", "runtime", "providers", id, "login", "start" | "cancel"] if provider(id) => "POST",
        ["", "api", "runtime", "runs", id, "respond"] if identifier(id, 128) => "POST",
        _ => return Err("不允许的本机助理管理路径。".into()),
    };
    if request.method != expected { return Err("该本机管理路径不支持此请求方法。".into()); }
    if let Some(query) = query {
        if !path.ends_with("/sessions") || query.is_empty() { return Err("该管理路径不接受查询参数。".into()); }
        let pairs: Vec<_> = reqwest::Url::parse(&format!("{ENDPOINT}/?{query}"))
            .map_err(|_| "管理查询参数无效。")?.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        if pairs.len() != 1 || pairs[0].0 != "agentId" || !identifier(&pairs[0].1, 128) {
            return Err("会话查询只允许一个有效的 agentId。".into());
        }
    }
    if let Some(body) = &request.body {
        if expected != "POST" || !body.is_object() || serde_json::to_vec(body).map_err(|_| "管理参数格式无效。")?.len() > MAX_BODY {
            return Err("本机管理请求必须使用容量范围内的 JSON 对象。".into());
        }
    }
    let url = Url::parse(&format!("{ENDPOINT}{}", request.path)).map_err(|_| "管理路径无效。")?;
    Ok((if expected == "GET" { Method::GET } else { Method::POST }, url))
}

pub(crate) fn validate_endpoint(raw: &str) -> Result<(), String> {
    if raw.trim().trim_end_matches('/') != ENDPOINT { return Err("此助理只能通过 AntDesk 本机连接服务运行。".into()); }
    Ok(())
}

fn project_root() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Some(root) = std::env::var_os("ANTDESK_PROJECT_ROOT") { candidates.push(PathBuf::from(root)); }
    if let Some(root) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() { candidates.push(root.to_path_buf()); }
    if let Ok(exe) = std::env::current_exe() { candidates.extend(exe.ancestors().skip(1).take(5).map(Path::to_path_buf)); }
    candidates.into_iter().find(|root| root.join("assistant-bridge/cli.mjs").is_file() && root.join("assistant-bridge/server.mjs").is_file())
        .ok_or_else(|| "找不到已安装的 AntDesk 助理连接服务，请修复应用安装。".into())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrivateConfig { version: u32, host: String, port: u16, admin_token: String }
fn private_key(root: &Path) -> Result<String, String> {
    let path = root.join(".antdesk/native-bridge/config.json");
    let metadata = std::fs::metadata(&path).map_err(|_| "本机助理连接配置不可用。")?;
    if metadata.len() > 128 * 1024 { return Err("本机助理连接配置超出容量限制。".into()); }
    let data = std::fs::read(&path).map_err(|_| "无法读取本机助理连接配置。")?;
    let config: PrivateConfig = serde_json::from_slice(&data).map_err(|_| "本机助理连接配置格式无效。")?;
    if config.version != 1 || config.host != "127.0.0.1" || config.port != 47631 || config.admin_token.len() < 32 ||
        config.admin_token.len() > 8192 || config.admin_token.chars().any(char::is_control) {
        return Err("本机助理连接配置与安全监听地址不匹配。".into());
    }
    Ok(config.admin_token)
}

fn command(root: &Path, action: &str) -> tokio::process::Command {
    let binary = std::env::var_os("ANTDESK_NODE_BINARY").unwrap_or_else(|| "node".into());
    let mut command = tokio::process::Command::new(binary);
    command.arg(root.join("assistant-bridge/cli.mjs")).arg(action).arg("--config")
        .arg(root.join(".antdesk/native-bridge/config.json")).current_dir(root)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW; never a credential-bearing terminal.
    command
}

fn compatible_health(value: &Value) -> bool {
    value["service"] == "antdesk-native-bridge" && value["version"] == 1 && value["runtimeVersion"] == 1 &&
        value["capabilities"].as_array().is_some_and(|values| values.iter().any(|v| v == "assistant-runtimes"))
}
async fn read_json(mut response: reqwest::Response) -> Result<Value, String> {
    if response.content_length().is_some_and(|size| size > MAX_RESPONSE as u64) { return Err("本机助理响应超过容量限制。".into()); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "本机助理响应中断，请刷新原会话确认状态。")? {
        if bytes.len() + chunk.len() > MAX_RESPONSE { return Err("本机助理响应超过容量限制。".into()); }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "本机助理响应格式无效。".into())
}
async fn health(client: &reqwest::Client) -> Result<bool, String> {
    let response = match client.get(format!("{ENDPOINT}/health")).timeout(Duration::from_secs(2)).send().await {
        Ok(response) => response,
        // Windows may report an unbound loopback port as a request timeout
        // instead of a connect error. Both mean there is no verified service
        // yet; startup may proceed, without accepting an incompatible reply.
        Err(error) if error.is_connect() || error.is_timeout() => return Ok(false),
        Err(_) => return Err("本机助理服务暂时未响应，请稍后重试。".into()),
    };
    if !response.status().is_success() || !compatible_health(&read_json(response).await?) {
        return Err("本机端口正在运行不兼容的服务；请重启 AntDesk 连接服务后重试。".into());
    }
    Ok(true)
}
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3)).timeout(Duration::from_secs(35)).build()
        .map_err(|_| "无法建立本机助理连接。".into())
}

/// Called for native protocol commands as well as management. Startup never logs in or sends a task.
pub(crate) async fn ensure_running() -> Result<String, String> {
    let _guard = START_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    let root = project_root()?;
    let config_path = root.join(".antdesk/native-bridge/config.json");
    if !config_path.is_file() {
        let mut init = command(&root, "init");
        init.kill_on_drop(true);
        let status = tokio::time::timeout(Duration::from_secs(10), init.status()).await
            .map_err(|_| "初始化本机助理连接超时。")?.map_err(|_| "无法启动 Node.js，请修复本机助理运行环境。")?;
        if !status.success() { return Err("本机助理初始化失败，现有配置未被覆盖。".into()); }
    }
    let key = private_key(&root)?;
    // The planner can fall back to an ephemeral loopback port when an old
    // listener occupies the preferred one. Discovery contains no credential.
    let endpoint_path = root.join(".antdesk/native-bridge/planner-endpoint.json");
    let endpoint_temp = endpoint_path.with_extension("json.tmp");
    let endpoint = serde_json::to_vec(&serde_json::json!({"version":1,"url":super::task_hub::queue_endpoint()}))
        .map_err(|_| "无法生成本机待办连接信息。")?;
    std::fs::write(&endpoint_temp, endpoint).and_then(|_| std::fs::rename(&endpoint_temp, &endpoint_path))
        .map_err(|_| "无法保存本机待办连接信息，请检查工程目录权限。")?;
    let client = client()?;
    if health(&client).await? { super::task_hub::set_queue_key(&key); return Ok(key); }
    let mut child = command(&root, "start").spawn().map_err(|_| "无法启动本机助理服务，请检查 Node.js 安装。")?;
    for _ in 0..32 {
        tokio::time::sleep(Duration::from_millis(250)).await;
        if health(&client).await? { super::task_hub::set_queue_key(&key); return Ok(key); }
        if child.try_wait().map_err(|_| "无法检查本机助理服务状态。")?.is_some() {
            return Err("本机助理服务启动失败，请修复运行环境后重试。".into());
        }
    }
    Err("本机助理服务仍在启动，请稍后重试。".into())
}

/// Scrub the private administrator key even if a faulty local provider echoes it in nested data.
pub(crate) fn redact(value: &mut Value, secrets: &[&str]) {
    match value {
        Value::String(text) => for secret in secrets.iter().filter(|value| !value.is_empty()) { *text = text.replace(*secret, "[已隐藏密钥]"); },
        Value::Array(values) => for value in values { redact(value, secrets); },
        Value::Object(values) => {
            values.retain(|key, _| !matches!(key.to_ascii_lowercase().as_str(), "admintoken" | "admin_token" | "bridgeapikey" | "bridge_api_key" | "apikey" | "api_key" | "accesstoken" | "access_token" | "refreshtoken" | "refresh_token" | "bottokens"));
            for value in values.values_mut() { redact(value, secrets); }
        }
        _ => (),
    }
}

#[tauri::command]
pub async fn assistant_runtime_request(request: RuntimeRequest) -> Result<Value, String> {
    let (method, url) = route(&request)?;
    let key = ensure_running().await?;
    let is_post = method == Method::POST;
    let mut outgoing = client()?.request(method, url).bearer_auth(&key);
    if is_post { outgoing = outgoing.json(request.body.as_ref().unwrap_or(&serde_json::json!({}))); }
    let response = outgoing.send().await.map_err(|_| "本机助理请求未确认完成，请刷新原会话；不要重复提交确认。")?;
    let status = response.status();
    let mut value = read_json(response).await?;
    let mut secrets = vec![key.as_str()];
    if let Some(api_key) = request.body.as_ref().and_then(|body| body.get("apiKey")).and_then(Value::as_str) { secrets.push(api_key); }
    redact(&mut value, &secrets);
    if !status.is_success() {
        if matches!(status.as_u16(), 401 | 403) { return Err("本机助理身份验证失败，请重启连接服务。".into()); }
        let message = value["error"]["message"].as_str().or_else(|| value["message"].as_str()).filter(|text| !text.is_empty() && text.len() <= 8192);
        return Err(message.map(str::to_string).unwrap_or_else(|| format!("本机助理管理请求失败（HTTP {}）。", status.as_u16())));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(method: &str, path: &str) -> RuntimeRequest { RuntimeRequest { method: method.into(), path: path.into(), body: None } }
    #[test]
    fn management_routes_reject_origin_traversal_wrong_methods_and_extra_queries() {
        for path in ["https://example.test/api/runtime/providers", "//example.test/api/runtime/providers", "/api/runtime/providers/../runs/1/respond", "/api/runtime/providers/%2e%2e/providers", "/api/runtime/providers#token", "/api/runtime/providers?secret=x", "/api/runtime/providers/grok-direct/sessions?agentId=bot&agentId=other", "/api/runtime/providers/grok-direct/sessions?agentId=../bot", "/api/runtime/providers/grok-direct/sessions?url=https://example.test"] {
            assert!(route(&request("GET", path)).is_err(), "{path}");
        }
        assert!(route(&request("POST", "/api/runtime/providers")).is_err());
        assert!(route(&request("GET", "/api/runtime/providers/grok-direct/login/start")).is_err());
        assert!(route(&request("GET", "/api/runtime/providers/other/agents")).is_err());
        for id in ["grok-direct", "dots-direct", "muse-code", "deepseek-harness", "muse-personal", "notion-web"] {
            for suffix in ["agents", "sessions", "login/status", "sessions?agentId=real-bot.id", "sessions?agentId=dot~one"] {
                assert!(route(&request("GET", &format!("/api/runtime/providers/{id}/{suffix}"))).is_ok());
            }
            for suffix in ["configure", "logout", "login/start", "login/cancel"] {
                assert!(route(&request("POST", &format!("/api/runtime/providers/{id}/{suffix}"))).is_ok());
            }
        }
        assert!(route(&request("POST", "/api/runtime/runs/run-123/respond")).is_ok());
    }
    #[test]
    fn body_is_bounded_and_health_requires_runtime_identity() {
        let mut r = request("GET", "/api/runtime/providers"); r.body = Some(serde_json::json!({})); assert!(route(&r).is_err());
        let mut r = request("POST", "/api/runtime/providers/deepseek-harness/configure"); r.body = Some(serde_json::json!({"apiKey":"user-secret"})); assert!(route(&r).is_ok());
        r.body = Some(Value::String("x".into())); assert!(route(&r).is_err());
        assert!(!compatible_health(&serde_json::json!({"service":"antdesk-native-bridge","version":1})));
        assert!(compatible_health(&serde_json::json!({"service":"antdesk-native-bridge","version":1,"runtimeVersion":1,"capabilities":["assistant-runtimes"]})));
    }
    #[test]
    fn private_keys_never_survive_nested_management_responses() {
        let mut value = serde_json::json!({"adminToken":"admin-secret","apiKey":"user-secret","items":[{"message":"admin-secret user-secret"}],"deviceCode":"public-login-code"});
        redact(&mut value, &["admin-secret", "user-secret"]);
        assert!(!value.to_string().contains("admin-secret")); assert!(!value.to_string().contains("user-secret"));
        assert_eq!(value["deviceCode"], "public-login-code");
    }
}
