use crate::agent_jobs::{AgentAttention, AgentProfile};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};

pub const PROTOCOLS: [&str; 4] = ["muse-personal", "grok-direct", "dots-direct", "notion-web"];
pub type Audience = BTreeMap<String, String>;
pub(super) fn error(e: impl std::fmt::Display) -> String { format!("助理聊天存储：{e}") }
pub(super) fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis().min(i64::MAX as u128) as i64
}
pub(super) fn hash(value: &str) -> String { format!("{:x}", Sha256::digest(value.as_bytes())) }
pub(super) fn short(value: &str, chars: usize) -> String { value.chars().take(chars).collect() }
pub(super) fn field(value: &str, label: &str, max: usize) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > max || value.contains('\0') { return Err(format!("{label}为空或超过长度限制。")); }
    Ok(())
}
pub(super) fn profiles_valid(profiles: &[AgentProfile]) -> Result<(), String> {
    if profiles.is_empty() || profiles.len() > PROTOCOLS.len() { return Err("请提供当前个人助理的连接配置。".into()); }
    let mut ids = HashSet::new(); let mut protocols = HashSet::new();
    for p in profiles {
        field(&p.id, "助理编号", 128)?; field(&p.name, "助理名称", 128)?;
        if p.id.chars().any(char::is_control) || !PROTOCOLS.contains(&p.protocol.as_str()) || !ids.insert(&p.id) || !protocols.insert(&p.protocol) {
            return Err("聊天支持 Muse AI、Grok Bot、GPT omdot、Notion AI 各一位。".into());
        }
        crate::assistant_runtime::validate_endpoint(&p.endpoint)?;
        if p.agent_ref.len() > 256 || p.session_id.as_ref().is_some_and(|s| s.len() > 256) { return Err("助理原会话编号过长。".into()); }
    }
    Ok(())
}
pub(super) fn route_key(p: &AgentProfile) -> String {
    hash(&serde_json::json!([p.id,p.protocol,p.endpoint.trim_end_matches('/'),p.agent_ref,p.session_id]).to_string())
}
pub(super) fn binding(p: &AgentProfile, identity: &str) -> String {
    if identity.is_empty() { String::new() } else { hash(&format!("{}:{identity}", route_key(p))) }
}
pub(super) fn dm_id(p: &ResolvedProfile) -> String {
    format!("dm:{}:{}", p.profile.id, &hash(&format!("{}:{}", route_key(&p.profile), p.binding))[..20])
}

#[derive(Clone)]
pub(super) struct ResolvedProfile {
    pub profile: AgentProfile,
    pub binding: String,
    pub ready: bool,
    pub message: String,
    pub concrete_agent_id: Option<String>,
    pub concrete_session_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ChatRoom {
    pub id: String, pub kind: String, pub title: String, pub member_ids: Vec<String>,
    pub updated_at: i64, pub last_message: String, pub pending_count: i64,
    pub archived: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ChatMessage {
    pub id: String, pub seq: i64, pub room_id: String, pub role: String,
    pub author_id: String, pub author_name: String, pub text: String, pub status: String,
    pub created_at: i64, pub updated_at: i64, pub mentions: Vec<String>,
    #[serde(skip_serializing_if="Option::is_none")] pub reply_to: Option<String>,
    #[serde(skip_serializing_if="Option::is_none")] pub delivery_id: Option<String>,
    #[serde(skip_serializing_if="Option::is_none")] pub run_id: Option<String>,
    pub progress: String, pub error: String,
    #[serde(skip_serializing_if="Option::is_none")] pub attention: Option<AgentAttention>,
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct ChatHistory {
    pub messages: Vec<ChatMessage>, pub has_more: bool,
    #[serde(skip_serializing_if="Option::is_none")] pub next_before: Option<i64>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct SendRequest {
    pub room_id: String, pub client_message_id: String, pub text: String,
    pub mentions: Vec<String>, pub profiles: Vec<AgentProfile>,
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct SentMessage { pub message_id: String, pub room_id: String }

#[derive(Clone)]
pub(super) struct Delivery {
    pub id: String, pub room_id: String, pub user_message_id: String,
    pub reply_message_id: String, pub profile: AgentProfile, pub identity: String,
    pub run_id: Option<String>, pub run_key: String, pub attempt: i64,
    pub status: String, pub attempted: bool, pub instruction: String,
    pub user_seq: i64,
}
