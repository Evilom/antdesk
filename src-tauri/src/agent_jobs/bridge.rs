//! Desktop client for AntDesk's native bridge, not a model API adapter.
use super::{AgentAttention, AgentMessage, AgentProfile, ProbeResult, StartRunRequest};
use reqwest::{Method, Url};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{net::IpAddr, time::Duration};

const MAX_RESPONSE: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Snapshot {
    pub id: String,
    pub status: String,
    pub delivery_status: String,
    #[serde(default)]
    pub progress: String,
    #[serde(default)]
    pub result: String,
    #[serde(default)]
    pub error: String,
    pub updated_at: i64,
    #[serde(default, deserialize_with = "super::optional_session")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub attention: Option<AgentAttention>,
    #[serde(default)]
    pub messages: Vec<AgentMessage>,
    #[serde(default)]
    pub remote_stopped: Option<bool>,
}
impl Snapshot {
    pub fn is_terminal(&self) -> bool { matches!(self.status.as_str(), "review" | "failed" | "cancelled") }
}
fn loopback(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost") || host.trim_matches(['[', ']']).parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}
fn safe_url(raw: &str, local_http: bool) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|_| "连接地址无效。")?;
    let valid_scheme = url.scheme() == "https" || (local_http && url.scheme() == "http" && url.host_str().is_some_and(loopback));
    if !valid_scheme || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err("连接地址须为 HTTPS（本机桥接服务可用 HTTP），且不能包含账号、查询参数或密钥。".into());
    }
    Ok(url)
}
pub(super) fn normalized_endpoint(raw: &str) -> Result<String, String> {
    Ok(safe_url(raw, true)?.to_string().trim_end_matches('/').to_string())
}
pub(super) fn validate_profile(profile: &AgentProfile) -> Result<(), String> {
    if !profile.is_native() { return Err("不支持该原生助理协议。".into()); }
    safe_url(&profile.endpoint, true)?;
    if profile.is_runtime() { crate::assistant_runtime::validate_endpoint(&profile.endpoint)?; }
    let id = profile.agent_ref();
    if id.is_empty() || id.len() > 128 || !id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~')) {
        return Err("助理标识只能包含英文字母、数字、点、短横线、下划线或波浪号。".into());
    }
    if profile.protocol == "grok-webhook" { safe_url(&profile.webhook_url, false)?; }
    if matches!(profile.protocol.as_str(), "grok-direct" | "dots-direct") && profile.agent_ref.trim().is_empty() { return Err("请从已登录的账号选择原 Bot 或 Dot。".into()); }
    if profile.session_id.as_ref().is_some_and(|id| id.is_empty() || id.len() > 256 || id.chars().any(char::is_control)) {
        return Err("原会话编号格式无效。".into());
    }
    Ok(())
}

#[derive(Debug)]
pub(super) struct SubmitError {
    pub message: String,
    pub definitive: bool,
}
impl SubmitError {
    fn uncertain(message: impl Into<String>) -> Self { Self { message: message.into(), definitive: false } }
}
impl From<String> for SubmitError { fn from(value: String) -> Self { Self::uncertain(value) } }
impl From<&str> for SubmitError { fn from(value: &str) -> Self { Self::uncertain(value) } }

pub(super) struct Client {
    client: reqwest::Client,
    base: Url,
    key: String,
}
impl Client {
    pub fn new(profile: &AgentProfile, key: Option<&str>) -> Result<Self, String> {
        if profile.is_runtime() { crate::assistant_runtime::validate_endpoint(&profile.endpoint)?; }
        let base = safe_url(&profile.endpoint, true)?;
        let key = key.filter(|s| !s.trim().is_empty()).ok_or("请填写 AntDesk 桥接服务的会话密钥。")?;
        let mut builder = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none());
        if profile.is_runtime() { builder = builder.no_proxy(); }
        let client = builder
            .connect_timeout(Duration::from_secs(5)).timeout(Duration::from_secs(20))
            .build().map_err(|_| "无法建立桥接连接。")?;
        Ok(Self { client, base, key: key.to_string() })
    }
    fn url(&self, segments: &[&str]) -> Result<Url, String> {
        let mut url = self.base.clone();
        { let mut path = url.path_segments_mut().map_err(|_| "桥接地址无效。")?; path.pop_if_empty(); for s in segments { path.push(s); } }
        Ok(url)
    }
    async fn request_raw(&self, method: Method, url: Url, body: Option<Value>) -> Result<Value, SubmitError> {
        let mut request = self.client.request(method, url).bearer_auth(&self.key);
        if let Some(body) = body { request = request.json(&body); }
        let mut response = request.send().await.map_err(|e| if e.is_timeout() {
            "桥接连接超时，任务结果尚未确认。可使用“同步进度”查询原执行，请勿重复派发。"
        } else { "无法连接桥接服务，任务结果尚未确认。请恢复连接后同步原执行。" })?;
        let status = response.status();
        if !status.is_success() {
            let message = match status.as_u16() {
                401 | 403 => "桥接身份验证失败，请重新填写桥接服务会话密钥。".into(),
                404 => "桥接服务未找到原执行或接口，请检查连接地址；不会自动重发任务。".into(),
                409 => "桥接服务尚未准备好或执行编号冲突，请检查助理连接及订阅。".into(),
                422 => "桥接服务拒绝了任务参数，请核对助理标识和 Webhook 设置。".into(),
                429 => "桥接服务暂时限流，请稍后同步原执行。".into(),
                n => format!("桥接服务返回 HTTP {n}，任务结果尚未确认。"),
            };
            return Err(SubmitError { message, definitive: matches!(status.as_u16(), 400 | 401 | 403 | 404 | 405 | 409 | 413 | 415 | 422 | 429) });
        }
        if response.content_length().is_some_and(|n| n > MAX_RESPONSE as u64) { return Err("桥接响应超过容量限制。".into()); }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "桥接响应中断，请同步原执行确认结果。")? {
            if bytes.len() + chunk.len() > MAX_RESPONSE { return Err("桥接响应超过容量限制。".into()); }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| "桥接响应格式无效，请核对 AntDesk 原生桥接服务版本。".into())
    }
    async fn request(&self, method: Method, url: Url, body: Option<Value>) -> Result<Value, String> {
        self.request_raw(method, url, body).await.map_err(|e| e.message)
    }
    fn snapshot(&self, mut value: Value, id: &str, extra_secret: Option<&str>) -> Result<Snapshot, String> {
        let secrets: Vec<&str> = [Some(self.key.as_str()), extra_secret].into_iter().flatten().collect();
        crate::assistant_runtime::redact(&mut value, &secrets);
        let mut s: Snapshot = serde_json::from_value(value).map_err(|_| "桥接执行记录格式无效。")?;
        if s.id != id || s.updated_at < 0 ||
            !matches!(s.status.as_str(), "queued" | "running" | "review" | "failed" | "cancelled" | "interrupted") ||
            !matches!(s.delivery_status.as_str(), "pending" | "accepted" | "unknown" | "rejected") {
            return Err("桥接返回了不匹配的执行记录，已停止更新。".into());
        }
        if s.progress.len() > 64 * 1024 || s.error.len() > 64 * 1024 || s.result.len() > 3 * 1024 * 1024 {
            return Err("桥接执行内容超过容量限制。".into());
        }
        if s.status == "review" && s.result.trim().is_empty() { return Err("助理报告完成但未交回结果，请继续同步或核对原会话。".into()); }
        if [s.session_id.as_ref(), s.turn_id.as_ref(), s.cursor.as_ref()].into_iter().flatten().any(|value| value.len() > 4096 || value.chars().any(char::is_control)) ||
            s.messages.len() > 128 || s.messages.iter().any(|message| message.id.is_empty() || message.id.len() > 256 ||
                !matches!(message.role.as_str(), "assistant" | "tool" | "user") || message.text.len() > 128 * 1024 || message.updated_at.is_some_and(|at| at < 0)) {
            return Err("助理会话或消息记录格式无效。".into());
        }
        if let Some(attention) = &s.attention {
            if attention.id.is_empty() || attention.id.len() > 512 || !matches!(attention.kind.as_str(), "approval" | "input" | "login") ||
                attention.title.is_empty() || attention.title.len() > 8192 || attention.description.as_ref().is_some_and(|text| text.len() > 64 * 1024) ||
                attention.options.as_ref().is_some_and(|options| options.len() > 64 || options.iter().any(|v| v.id.is_empty() || v.id.len() > 512 || v.label.len() > 4096)) ||
                attention.fields.as_ref().is_some_and(|fields| fields.len() > 64 || fields.iter().any(|v| v.id.is_empty() || v.id.len() > 512 || v.label.len() > 4096)) {
                return Err("助理待确认事项格式无效。".into());
            }
        }
        for secret in [Some(self.key.as_str()), extra_secret].into_iter().flatten().filter(|k| !k.is_empty()) {
            s.progress = s.progress.replace(secret, "[已隐藏密钥]");
            s.result = s.result.replace(secret, "[已隐藏密钥]");
            s.error = s.error.replace(secret, "[已隐藏密钥]");
        }
        Ok(s)
    }
    pub async fn submit(&self, id: &str, request: &StartRunRequest, webhook_key: Option<&str>) -> Result<Snapshot, SubmitError> {
        let mut body = json!({
            "id": id, "idempotencyKey": request.idempotency_key, "taskId": request.task_id,
            "title": request.title, "instruction": request.instruction, "context": request.context,
            "parentRunId": request.parent_run_id, "agentId": request.profile.agent_ref(), "protocol": request.profile.protocol
        });
        if request.profile.protocol == "grok-webhook" {
            body["webhookUrl"] = json!(request.profile.webhook_url);
            body["webhookKey"] = json!(webhook_key.filter(|v| !v.is_empty()).ok_or("请填写 Grok Webhook 密钥。")?);
        }
        if request.profile.is_runtime() {
            if let Some(session_id) = &request.profile.session_id { body["sessionId"] = json!(session_id); }
        }
        if request.profile.protocol == "notion-web" { body["model"] = json!(request.profile.model); }
        // A single POST. Ambiguous network failure is reconciled by GET; it is never automatically retried.
        let value = self.request_raw(Method::POST, self.url(&["api", "runs"])?, Some(body)).await?;
        self.snapshot(value, id, webhook_key).map_err(SubmitError::uncertain)
    }
    pub async fn get(&self, id: &str) -> Result<Snapshot, String> {
        let value = self.request(Method::GET, self.url(&["api", "runs", id])?, None).await?;
        self.snapshot(value, id, None)
    }
    pub async fn cancel(&self, id: &str) -> Result<Snapshot, String> {
        let value = self.request(Method::POST, self.url(&["api", "runs", id, "cancel"])?, Some(json!({}))).await?;
        self.snapshot(value, id, None)
    }
    pub async fn probe(&self, profile: &AgentProfile) -> Result<ProbeResult, String> {
        if profile.is_runtime() {
            let value = self.request(Method::GET, self.url(&["api", "runtime", "providers"])?, None).await?;
            let provider = value["providers"].as_array().and_then(|providers| providers.iter().find(|item| item["id"] == profile.protocol && item["protocol"] == profile.protocol))
                .ok_or("本机服务没有返回匹配的助理运行环境。")?;
            let readiness = provider["readiness"].as_str().filter(|value| matches!(*value, "ready" | "connecting" | "needs_model" | "needs_login" | "needs_api_key" | "needs_install" | "needs_validation" | "invalid_credentials" | "needs_agent_connection" | "needs_configuration" | "needs_subscription" | "blocked" | "unavailable"))
                .ok_or("本机助理就绪状态无效。")?;
            let mut message = provider["message"].as_str().filter(|text| text.len() <= 8192).unwrap_or("请在助理连接向导完成设置。").to_string();
            message = message.replace(&self.key, "[已隐藏密钥]");
            return Ok(ProbeResult { ok: readiness == "ready", message, readiness: Some(readiness.into()), official: Some(provider["official"] == true), mcp_url: None });
        }
        let mut url = self.url(&["api", "status"])?;
        url.query_pairs_mut().append_pair("agentId", profile.agent_ref()).append_pair("protocol", &profile.protocol);
        let value = self.request(Method::GET, url, None).await?;
        if value["service"] != "antdesk-native-bridge" || value["version"] != 1 || value["agentId"] != profile.agent_ref() || value["protocol"] != profile.protocol {
            return Err("这个地址没有返回匹配的 AntDesk 原生桥接状态。".into());
        }
        let readiness = value["readiness"].as_str().unwrap_or("unavailable");
        let ready = readiness == "ready" && value["ready"] == true;
        let message = match readiness {
            "ready" if profile.protocol == "grok-webhook" => "桥接与助理回写连接已就绪。Grok Webhook 密钥将在正式派发时验证，本次检查没有启动助理。",
            "ready" => "DOTS 事件订阅与回写通道已就绪。本次检查没有启动助理。",
            "needs_subscription" => "桥接服务可用，尚未收到该 DOTS 的事件订阅。请先让 DOTS 订阅分配给它的事项。",
            "needs_public_url" => "桥接服务可用，尚未设置助理可访问的 HTTPS 地址。",
            "needs_agent_connection" => "桥接服务可用，尚未绑定该助理的 MCP 回写连接。",
            _ => "桥接服务可访问，但该助理尚未就绪。请检查桥接配置。",
        };
        let mcp_url = value["mcpUrl"].as_str().and_then(|raw| safe_url(raw, false).ok()).map(|url| url.to_string());
        Ok(ProbeResult { ok: ready, message: message.into(), readiness: Some(readiness.to_string()), official: Some(true), mcp_url })
    }
}

#[cfg(test)]
#[path = "bridge_tests.rs"]
mod tests;
