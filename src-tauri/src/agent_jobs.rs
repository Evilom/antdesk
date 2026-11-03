//! Durable assistant runs with official native bot adapters and explicit result review.
mod bridge;
mod runtime;
mod store;
mod transport;

use serde::{Deserialize, Serialize};
use std::{collections::HashMap, future::Future, sync::{atomic::AtomicU64, Arc, Mutex}, time::{SystemTime, UNIX_EPOCH}};
use tauri::Emitter;
use tokio::sync::{watch, Semaphore};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static QUEUE_CACHE: Mutex<Vec<serde_json::Value>> = Mutex::new(Vec::new());
pub(crate) fn current_queue() -> Vec<serde_json::Value> { QUEUE_CACHE.lock().map(|tasks| tasks.clone()).unwrap_or_default() }
#[tauri::command]
pub fn assistant_set_queue_cache(tasks: Vec<serde_json::Value>) {
    let mut seen = std::collections::HashSet::new();
    if let Ok(mut cache) = QUEUE_CACHE.lock() {
        *cache = tasks.into_iter().filter(|task| {
            task["id"].as_str().is_some_and(|id| seen.insert(id.to_owned())) && task["title"].is_string()
        }).take(10000).collect();
    }
}
fn now_ms() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(i64::MAX as u128) as i64 }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfile {
    pub id: String,
    pub name: String,
    pub endpoint: String,
    #[serde(default)]
    pub model: String,
    pub protocol: String,
    #[serde(default)]
    pub agent_ref: String,
    #[serde(default)]
    pub webhook_url: String,
    #[serde(default, deserialize_with = "optional_session", skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}
fn optional_session<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    Ok(Option::<String>::deserialize(deserializer)?.filter(|value| !value.trim().is_empty()))
}
fn is_native_protocol(protocol: &str) -> bool {
    matches!(protocol, "grok-webhook" | "dots-mcp" | "grok-direct" | "dots-direct" | "muse-code" | "deepseek-harness" | "muse-personal" | "notion-web")
}
impl AgentProfile {
    fn is_native(&self) -> bool { is_native_protocol(&self.protocol) }
    fn is_runtime(&self) -> bool { matches!(self.protocol.as_str(), "grok-direct" | "dots-direct" | "muse-code" | "deepseek-harness" | "muse-personal" | "notion-web") }
    fn agent_ref(&self) -> &str { if self.agent_ref.trim().is_empty() { &self.id } else { self.agent_ref.trim() } }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionOption { pub id: String, pub label: String }
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionField {
    pub id: String, pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<bool>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAttention {
    pub id: String, pub kind: String, pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<AttentionOption>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<AttentionField>>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    pub id: String, pub role: String, pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub complete: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRunRequest {
    pub idempotency_key: String,
    pub task_id: String,
    pub title: String,
    pub instruction: String,
    pub profile: AgentProfile,
    pub context: Option<String>,
    pub parent_run_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRun {
    pub id: String,
    pub idempotency_key: String,
    pub task_id: String,
    pub title: String,
    pub instruction: String,
    pub agent_id: String,
    pub agent_name: String,
    pub status: String,
    pub result: String,
    pub error: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_decision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reviewed_at: Option<i64>,
    pub protocol: String,
    pub progress: String,
    pub delivery_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attention: Option<AgentAttention>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub messages: Vec<AgentMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_stopped: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub ok: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub readiness: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub official: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_url: Option<String>,
}

/// Credentials never enter browser profiles, run snapshots, URLs, or SQLite.
struct BoundCredential { key: String, endpoint: String }
pub struct AgentJobsState {
    credentials: Mutex<HashMap<String, String>>,
    bridge_credentials: Mutex<HashMap<String, BoundCredential>>,
    controls: Mutex<HashMap<String, watch::Sender<bool>>>,
    per_agent: Mutex<HashMap<String, Arc<Semaphore>>>,
    global: Arc<Semaphore>,
}
impl Default for AgentJobsState {
    fn default() -> Self {
        Self { credentials: Mutex::new(HashMap::new()), bridge_credentials: Mutex::new(HashMap::new()),
            controls: Mutex::new(HashMap::new()), per_agent: Mutex::new(HashMap::new()), global: Arc::new(Semaphore::new(3)) }
    }
}
fn field(value: &str, name: &str, max: usize) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > max { Err(format!("{name}为空或超过长度限制。")) } else { Ok(()) }
}
fn validate_profile(profile: &AgentProfile) -> Result<(), String> {
    field(&profile.id, "助理编号", 128)?;
    field(&profile.name, "助理名称", 128)?;
    field(&profile.endpoint, "助理接口", 2048)?;
    if profile.is_native() { bridge::validate_profile(profile) }
    else if profile.protocol == "openai" {
        field(&profile.model, "模型名称", 256)?;
        transport::endpoint(profile).map(|_| ())
    } else { Err("该助理接入尚未实现，不能发起真实委派。请选择已支持的官方接入方式。".into()) }
}
fn validate_request(request: &StartRunRequest) -> Result<(), String> {
    field(&request.idempotency_key, "操作编号", 128)?;
    field(&request.task_id, "事项编号", 256)?;
    field(&request.title, "事项标题", 1000)?;
    field(&request.instruction, "委派要求", 40_000)?;
    if request.context.as_ref().is_some_and(|s| s.len() > 256 * 1024) { return Err("相关材料超过容量限制，请保留与本次委派有关的部分。".into()); }
    if let Some(parent) = &request.parent_run_id { field(parent, "接力编号", 128)?; }
    validate_profile(&request.profile)
}
fn credential(keys: &Mutex<HashMap<String, String>>, id: &str) -> Result<Option<String>, String> {
    keys.lock().map(|v| v.get(id).cloned()).map_err(|_| "会话密钥暂时不可用，请重启应用后重新设置。".into())
}
fn signal_change(app: &tauri::AppHandle, id: &str) { let _ = app.emit("planner:runs-changed", serde_json::json!({"runId": id})); }
async fn cancelled(receiver: &mut watch::Receiver<bool>) {
    loop { if *receiver.borrow() { return; } if receiver.changed().await.is_err() { return; } }
}
async fn cancellable<F: Future>(future: F, mut cancellation: watch::Receiver<bool>) -> Option<F::Output> {
    tokio::select! { biased; _ = cancelled(&mut cancellation) => None, result = future => Some(result) }
}
pub fn recover_interrupted(app: &tauri::AppHandle) -> Result<(), String> { store::recover(&super::pm::open(app)?)?; Ok(()) }

#[tauri::command]
pub fn assistant_list_runs(app: tauri::AppHandle) -> Result<Vec<AgentRun>, String> { store::list(&super::pm::open(&app)?) }

/// Internal readback for durable chat delivery reconciliation. Never submits.
pub(crate) fn chat_run(app: &tauri::AppHandle, id: &str) -> Result<AgentRun, String> {
    let c = super::pm::open(app)?; store::init(&c)?; store::get(&c, id)
}
pub(crate) fn chat_run_by_key(app: &tauri::AppHandle, key: &str) -> Result<Option<AgentRun>, String> {
    use rusqlite::OptionalExtension;
    let c = super::pm::open(app)?; store::init(&c)?;
    let id: Option<String> = c.query_row("SELECT id FROM assistant_runs WHERE idempotency_key=?1", [key], |r| r.get(0))
        .optional().map_err(|_| "无法读取原聊天执行记录。")?;
    id.map(|id| store::get(&c, &id)).transpose()
}

#[tauri::command]
pub async fn assistant_start_run(app: tauri::AppHandle, state: tauri::State<'_, AgentJobsState>, request: StartRunRequest) -> Result<AgentRun, String> {
    validate_request(&request)?;
    let primary = credential(&state.credentials, &request.profile.id)?;
    let bridge_key = if request.profile.is_native() { native_credential(&state, &request.profile).await? } else { None };
    if request.profile.is_native() {
        bridge::Client::new(&request.profile, bridge_key.as_deref())?;
        if request.profile.protocol == "grok-webhook" && primary.as_deref().is_none_or(str::is_empty) {
            return Err("请填写 Grok 工作流程的 Webhook 密钥。该密钥仅在派发时使用。".into());
        }
    }
    let slot = runtime::agent_slot(&state, &request.profile.id)?;
    let (run, created) = store::enqueue(&mut super::pm::open(&app)?, &request)?;
    if !created { return Ok(run); }
    runtime::start(app.clone(), run.id.clone(), request, primary, bridge_key, slot, state.global.clone())?;
    signal_change(&app, &run.id);
    Ok(run)
}

fn stop_run_worker(state: &AgentJobsState, id: &str) -> Result<(), String> {
    if let Some(sender) = state.controls.lock().map_err(|_| "无法访问跟进信号。")?.get(id) { let _ = sender.send(true); }
    Ok(())
}

#[tauri::command]
pub async fn assistant_cancel_run(app: tauri::AppHandle, state: tauri::State<'_, AgentJobsState>, run_id: String) -> Result<AgentRun, String> {
    field(&run_id, "执行编号", 128)?;
    let run = {
        let c = super::pm::open(&app)?;
        store::init(&c)?;
        let current = store::get(&c, &run_id)?;
        if !is_native_protocol(&current.protocol) {
            let stopped = store::cancel(&c, &run_id)?;
            if stopped.status == "cancelled" { stop_run_worker(&state, &run_id)?; }
            signal_change(&app, &run_id);
            return Ok(stopped);
        }
        // Atomic against prepare_dispatch: if this wins, no external POST can begin.
        if let Some(stopped) = store::cancel_before_dispatch(&c, &run_id)? {
            stop_run_worker(&state, &run_id)?;
            signal_change(&app, &run_id);
            return Ok(stopped);
        }
        let current = store::get(&c, &run_id)?;
        if current.external_run_id.is_none() || matches!(current.status.as_str(), "review" | "failed") { return Ok(current); }
        store::interrupt(&c, &run_id, "正在确认停止跟进。远端助理可能仍在执行。")?;
        store::get(&c, &run_id)?
    };
    // Dropping the in-flight sender/poller must not claim the bridge record has closed.
    stop_run_worker(&state, &run_id)?;
    signal_change(&app, &run_id);
    let outcome: Result<AgentRun, String> = async {
        let profile = store::route(&super::pm::open(&app)?, &run_id)?;
        let key = native_credential(&state, &profile).await?;
        let client = bridge::Client::new(&profile, key.as_deref())?;
        let snapshot = client.cancel(run.external_run_id.as_deref().unwrap()).await?;
        store::confirm_bridge_close(&super::pm::open(&app)?, &run_id, &snapshot)
    }.await;
    match outcome {
        Ok(confirmed) => { signal_change(&app, &run_id); Ok(confirmed) }
        Err(message) => {
            let c = super::pm::open(&app)?;
            let current = store::get(&c, &run_id)?;
            // Another response or concurrent cancel may already have established a real terminal state.
            if matches!(current.status.as_str(), "review" | "failed") || (current.status == "cancelled" && current.external_run_id.is_none()) {
                signal_change(&app, &run_id);
                return Ok(current);
            }
            let message = format!("停止跟进尚未确认：{message} 恢复连接或填写桥接密钥后，请再次点击“停止等待”。远端助理可能仍在执行。");
            store::interrupt(&c, &run_id, &message)?;
            signal_change(&app, &run_id);
            Err(message)
        }
    }
}

/// Reconcile by the durable external handle. This command never submits a new task.
#[tauri::command]
pub async fn assistant_sync_run(app: tauri::AppHandle, state: tauri::State<'_, AgentJobsState>, run_id: String) -> Result<AgentRun, String> {
    field(&run_id, "执行编号", 128)?;
    let (run, profile) = {
        let c = super::pm::open(&app)?;
        store::init(&c)?;
        (store::get(&c, &run_id)?, store::route(&c, &run_id)?)
    };
    if !profile.is_native() || run.external_run_id.is_none() { return Err("这次运行没有可同步的原生助理记录。".into()); }
    if !matches!(run.status.as_str(), "running" | "interrupted") { return Ok(run); }
    let key = native_credential(&state, &profile).await?;
    let client = bridge::Client::new(&profile, key.as_deref())?;
    let snapshot = client.get(run.external_run_id.as_deref().unwrap()).await?;
    {
        let c = super::pm::open(&app)?;
        store::apply_remote(&c, &run_id, &snapshot)?;
    }
    let updated = store::get(&super::pm::open(&app)?, &run_id)?;
    if matches!(updated.status.as_str(), "running" | "interrupted") {
        runtime::resume(app.clone(), updated.clone(), profile, key.unwrap())?;
    }
    signal_change(&app, &run_id);
    Ok(updated)
}

#[tauri::command]
pub fn assistant_review_run(app: tauri::AppHandle, run_id: String, decision: String) -> Result<AgentRun, String> {
    field(&run_id, "执行编号", 128)?;
    let c = super::pm::open(&app)?;
    store::init(&c)?;
    let run = store::review(&c, &run_id, &decision)?;
    signal_change(&app, &run_id);
    Ok(run)
}
fn set_credential(keys: &Mutex<HashMap<String, String>>, profile_id: &str, api_key: &str) -> Result<(), String> {
    field(profile_id, "助理编号", 128)?;
    let key = api_key.trim();
    if key.len() > 8192 || key.chars().any(char::is_control) { return Err("会话密钥格式无效。".into()); }
    let mut keys = keys.lock().map_err(|_| "无法保存会话密钥。")?;
    if key.is_empty() { keys.remove(profile_id); }
    else {
        if !keys.contains_key(profile_id) && keys.len() >= 64 { return Err("会话密钥数量已达上限。".into()); }
        keys.insert(profile_id.to_string(), key.to_string());
    }
    Ok(())
}
#[tauri::command]
pub fn assistant_set_credential(state: tauri::State<'_, AgentJobsState>, profile_id: String, api_key: String) -> Result<(), String> {
    set_credential(&state.credentials, &profile_id, &api_key)
}
fn bridge_credential(state: &AgentJobsState, id: &str, endpoint: &str) -> Result<Option<String>, String> {
    let endpoint = bridge::normalized_endpoint(endpoint)?;
    let keys = state.bridge_credentials.lock().map_err(|_| "桥接会话密钥暂时不可用。")?;
    match keys.get(id) {
        Some(value) if value.endpoint == endpoint => Ok(Some(value.key.clone())),
        Some(_) => Err("桥接密钥绑定的地址与原执行不同，请先为原地址重新填写密钥。不会向旧地址发送新服务的密钥。".into()),
        None => Ok(None),
    }
}
async fn native_credential(state: &AgentJobsState, profile: &AgentProfile) -> Result<Option<String>, String> {
    if profile.is_runtime() {
        crate::assistant_runtime::validate_endpoint(&profile.endpoint)?;
        crate::assistant_runtime::ensure_running().await.map(Some)
    } else { bridge_credential(state, &profile.id, &profile.endpoint) }
}
fn save_bridge_credential(state: &AgentJobsState, id: &str, key: &str, endpoint: Option<&str>) -> Result<(), String> {
    field(id, "助理编号", 128)?;
    let key = key.trim();
    if key.len() > 8192 || key.chars().any(char::is_control) { return Err("会话密钥格式无效。".into()); }
    let endpoint = if key.is_empty() { String::new() } else {
        bridge::normalized_endpoint(endpoint.ok_or("请为桥接会话密钥提供绑定地址。")?)?
    };
    let mut keys = state.bridge_credentials.lock().map_err(|_| "无法保存桥接会话密钥。")?;
    if key.is_empty() { keys.remove(id); }
    else {
        if !keys.contains_key(id) && keys.len() >= 64 { return Err("桥接会话密钥数量已达上限。".into()); }
        keys.insert(id.into(), BoundCredential { key: key.into(), endpoint });
    }
    Ok(())
}
#[tauri::command]
pub fn assistant_set_bridge_credential(state: tauri::State<'_, AgentJobsState>, profile_id: String, api_key: String, endpoint: Option<String>) -> Result<(), String> {
    save_bridge_credential(&state, &profile_id, &api_key, endpoint.as_deref())
}
fn probe_credential(value: Option<String>, keys: &Mutex<HashMap<String, String>>, id: &str, use_stored: bool) -> Result<Option<String>, String> {
    if let Some(value) = value {
        let value = value.trim();
        if value.len() > 8192 || value.chars().any(char::is_control) { return Err("测试密钥格式无效。".into()); }
        if !value.is_empty() { return Ok(Some(value.to_string())); }
    }
    if use_stored { credential(keys, id) } else { Ok(None) }
}
#[tauri::command]
pub async fn assistant_probe_agent(
    state: tauri::State<'_, AgentJobsState>, profile: AgentProfile,
    api_key: Option<String>, bridge_api_key: Option<String>, use_stored_credentials: Option<bool>,
) -> Result<ProbeResult, String> {
    validate_profile(&profile)?;
    if profile.is_runtime() {
        let key = native_credential(&state, &profile).await?;
        return bridge::Client::new(&profile, key.as_deref())?.probe(&profile).await;
    }
    let use_stored = use_stored_credentials.unwrap_or(true);
    let primary = probe_credential(api_key, &state.credentials, &profile.id, use_stored)?;
    let bridge_key = {
        let explicit = probe_credential(bridge_api_key, &Mutex::new(HashMap::new()), &profile.id, false)?;
        if explicit.is_some() { explicit } else if use_stored && profile.is_native() { bridge_credential(&state, &profile.id, &profile.endpoint)? } else { None }
    };
    if profile.is_native() { return bridge::Client::new(&profile, bridge_key.as_deref())?.probe(&profile).await; }
    Ok(match transport::probe(&profile, primary.as_deref()).await {
        Ok(()) => ProbeResult { ok: true, message: "已收到模型回复，文字任务接口可用。".into(), readiness: None, official: None, mcp_url: None },
        Err(message) => ProbeResult { ok: false, message, readiness: None, official: None, mcp_url: None },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancellation_drops_inflight_work() {
        use std::sync::atomic::{AtomicBool, Ordering};
        struct OnDrop(Arc<AtomicBool>);
        impl Drop for OnDrop { fn drop(&mut self) { self.0.store(true, Ordering::SeqCst); } }
        let dropped = Arc::new(AtomicBool::new(false));
        let flag = dropped.clone();
        let (began_tx, began_rx) = tokio::sync::oneshot::channel();
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let work = async move { let _guard = OnDrop(flag); let _ = began_tx.send(()); std::future::pending::<()>().await; };
        let running = tokio::spawn(cancellable(work, cancel_rx));
        began_rx.await.unwrap(); cancel_tx.send(true).unwrap();
        assert!(tokio::time::timeout(std::time::Duration::from_secs(1), running).await.unwrap().unwrap().is_none());
        assert!(dropped.load(Ordering::SeqCst));
    }
    #[tokio::test]
    async fn queued_cancellation_does_not_wait_for_an_available_slot() {
        let semaphore = Arc::new(Semaphore::new(0));
        let (cancel_tx, cancel_rx) = watch::channel(false);
        cancel_tx.send(true).unwrap();
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(1), cancellable(semaphore.acquire_owned(), cancel_rx)).await.unwrap();
        assert!(outcome.is_none());
    }
    #[test]
    fn credentials_are_separate_and_never_serialize_in_profiles() {
        let state = AgentJobsState::default();
        set_credential(&state.credentials, "grok", "webhook-test-secret").unwrap();
        save_bridge_credential(&state, "grok", "bridge-test-secret", Some("http://127.0.0.1:47631")).unwrap();
        assert_eq!(credential(&state.credentials, "grok").unwrap().as_deref(), Some("webhook-test-secret"));
        assert_eq!(bridge_credential(&state, "grok", "http://127.0.0.1:47631").unwrap().as_deref(), Some("bridge-test-secret"));
        set_credential(&state.credentials, "grok", "").unwrap();
        assert!(credential(&state.credentials, "grok").unwrap().is_none());
        assert!(bridge_credential(&state, "grok", "http://127.0.0.1:47631").unwrap().is_some());
        assert!(bridge_credential(&state, "grok", "https://other.example.test").is_err());
        save_bridge_credential(&state, "grok", "new-service-secret", Some("https://other.example.test")).unwrap();
        assert!(bridge_credential(&state, "grok", "http://127.0.0.1:47631").is_err());
    }
}
