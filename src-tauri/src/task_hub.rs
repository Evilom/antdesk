//! Durable planner snapshots. Existing PM journals and source records remain untouched.
mod pmo;
use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    io::{Read, Write},
    sync::Mutex,
};
use tauri::Emitter;

const MAX_PAYLOAD_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HubSnapshot {
    pub revision: u64,
    pub payload: Value,
}

fn error(e: impl std::fmt::Display) -> String {
    format!("安排存储失败：{e}")
}

fn init(c: &Connection) -> Result<(), String> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS planner_state (
           singleton INTEGER PRIMARY KEY CHECK(singleton=1),
           revision INTEGER NOT NULL CHECK(revision>=0),
           payload TEXT NOT NULL);
         INSERT OR IGNORE INTO planner_state(singleton,revision,payload) VALUES(1,0,'{}');",
    )
    .map_err(error)
}

fn load(c: &Connection) -> Result<HubSnapshot, String> {
    init(c)?;
    let (revision, text): (i64, String) = c
        .query_row(
            "SELECT revision,payload FROM planner_state WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(error)?;
    let payload: Value = serde_json::from_str(&text).map_err(error)?;
    if revision < 0 || !payload.is_object() {
        return Err("安排记录格式无效，原记录已保留，请先恢复备份。".into());
    }
    Ok(HubSnapshot {
        revision: revision as u64,
        payload,
    })
}

fn update(c: &Connection, expected_revision: u64, payload: Value) -> Result<HubSnapshot, String> {
    if !payload.is_object() {
        return Err("安排数据必须是一个对象。".into());
    }
    let text = serde_json::to_string(&payload).map_err(error)?;
    if text.len() > MAX_PAYLOAD_BYTES {
        return Err("安排记录超过容量限制，请先导出并整理历史。".into());
    }
    let revision = expected_revision
        .checked_add(1)
        .filter(|n| *n <= i64::MAX as u64)
        .ok_or("安排版本号无效。")?;
    init(c)?;
    let changed = c
        .execute(
            "UPDATE planner_state SET revision=?1,payload=?2 WHERE singleton=1 AND revision=?3",
            params![revision as i64, text, expected_revision as i64],
        )
        .map_err(error)?;
    if changed != 1 {
        return Err("TASK_HUB_CONFLICT: 安排已在其他窗口更新，请载入最新安排后重试。".into());
    }
    Ok(HubSnapshot { revision, payload })
}

fn save(c: &mut Connection, expected_revision: u64, payload: Value) -> Result<HubSnapshot, String> {
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error)?;
    let saved = update(&tx, expected_revision, payload)?;
    tx.commit().map_err(error)?;
    Ok(saved)
}

#[tauri::command]
pub fn task_hub_load(app: tauri::AppHandle) -> Result<HubSnapshot, String> {
    load(&super::pm::open(&app)?)
}

#[tauri::command]
pub fn task_hub_save(
    app: tauri::AppHandle,
    expected_revision: u64,
    payload: Value,
) -> Result<HubSnapshot, String> {
    save(&mut super::pm::open(&app)?, expected_revision, payload)
}

static QUEUE_LOCK: Mutex<()> = Mutex::new(());
static QUEUE_TOKEN: Mutex<Vec<u8>> = Mutex::new(Vec::new());
static QUEUE_PORT: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(47833);
pub fn queue_endpoint() -> String {
    format!("http://127.0.0.1:{}", QUEUE_PORT.load(std::sync::atomic::Ordering::Relaxed))
}
fn bind_queue(preferred_port: u16) -> std::io::Result<std::net::TcpListener> {
    std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, preferred_port))
        .or_else(|_| std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)))
}
pub fn queue_key(key: &str) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    hash.update(b"antdesk-queue-v1\0");
    hash.update(key.as_bytes());
    URL_SAFE_NO_PAD.encode(hash.finalize())
}
pub fn set_queue_key(key: &str) {
    if let Ok(mut token) = QUEUE_TOKEN.lock() {
        *token = queue_key(key).into_bytes();
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentQueueRequest {
    expected_revision: u64,
    ordered_task_ids: Vec<String>,
    #[serde(default)]
    rationale: String,
}
fn validate_id(id: &str) -> bool {
    id.len() <= 256
        && matches!(id.split_once(':'), Some(("local" | "notion", _)))
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'-' | b'_' | b'.'))
}
fn queue(snapshot: &HubSnapshot, tasks: &[Value]) -> Vec<Value> {
    let mut remaining: Vec<(&str, &str)> = tasks
        .iter()
        .filter_map(|task| {
            let id = task["id"].as_str()?;
            let title = task["title"].as_str()?;
            (validate_id(id) && !title.is_empty() && title.chars().count() <= 300)
                .then_some((id, title))
        })
        .collect();
    let mut ordered = Vec::new();
    for id in snapshot.payload["order"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|_| !pmo::enabled(snapshot))
    {
        if let Some(index) = remaining.iter().position(|task| task.0 == id) {
            ordered.push(remaining.remove(index));
        }
    }
    // The UI supplies buildPlan's exact active queue. Only already-explicit
    // order is reapplied here; automatic ranks retain their UI-relative order.
    ordered.extend(remaining);
    ordered
        .into_iter()
        .enumerate()
        .map(|(index, (id, title))| {
            let mut item = if pmo::enabled(snapshot) {
                pmo::task_context(snapshot, tasks.iter().find(|t|t["id"].as_str()==Some(id)).unwrap_or(&Value::Null))
            } else { json!({}) };
            item["id"]=json!(id);item["title"]=json!(title);item["rank"]=json!(index+1);item
        })
        .collect()
}

#[tauri::command]
pub fn task_hub_agent_queue(
    app: tauri::AppHandle,
    name: String,
    arguments: Value,
) -> Result<Value, String> {
    let _guard = QUEUE_LOCK.lock().map_err(|_| "安排服务暂时不可用。")?;
    let mut c = super::pm::open(&app)?;
    let todos = super::agent_jobs::current_queue();
    if name == "list_priority_queue" {
        let snapshot = load(&c)?;
        return Ok(json!({"revision": snapshot.revision, "tasks": queue(&snapshot, &todos), "pmo":pmo::context(&snapshot)}));
    }
    if name != "reorder_priority_queue" {
        return Err("不支持的事项队列操作。".into());
    }
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error)?;
    let snapshot = load(&tx)?;
    let tasks = queue(&snapshot, &todos);
    let request: AgentQueueRequest =
        serde_json::from_value(arguments).map_err(|_| "排序参数格式无效。")?;
    if request.rationale.len() > 16000 || request.ordered_task_ids.len() > 1000
        || request
            .ordered_task_ids
            .iter()
            .collect::<HashSet<_>>()
            .len()
            != request.ordered_task_ids.len()
        || request.ordered_task_ids.iter().any(|id| !validate_id(id))
    {
        return Err("排序必须只包含当前队列中的事项编号，且每项最多一次。".into());
    }
    if request.expected_revision != snapshot.revision {
        return Err("QUEUE_CONFLICT: 队列已更新，请重新读取后再排序。".into());
    }
    if request.ordered_task_ids
        == tasks
            .iter()
            .filter_map(|task| task["id"].as_str().map(str::to_owned))
            .collect::<Vec<_>>()
    {
        return Ok(json!({"revision": snapshot.revision, "tasks": tasks,"reviewRequired":pmo::enabled(&snapshot),"unchanged":true}));
    }
    if request
        .ordered_task_ids
        .iter()
        .any(|id| !tasks.iter().any(|task| task["id"].as_str() == Some(id)))
    {
        return Err("有事项已离开当前队列，请重新读取后再排序。".into());
    }
    let mut order = request.ordered_task_ids;
    let unmentioned = tasks
        .iter()
        .filter_map(|task| task["id"].as_str())
        .filter(|id| !order.iter().any(|chosen| chosen == id))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    order.extend(unmentioned);
    if pmo::enabled(&snapshot) {
        let proposal=pmo::propose(&snapshot,&tasks,&order,&request.rationale)?;
        let saved=if proposal.created { update(&tx,snapshot.revision,proposal.payload)? } else { snapshot };
        tx.commit().map_err(error)?;
        if proposal.created { let _=app.emit("planner:changed",json!({"revision":saved.revision})); }
        return Ok(json!({"revision":saved.revision,"tasks":queue(&saved,&todos),"pmo":pmo::context(&saved),
            "reviewRequired":true,"proposalId":proposal.id,"message":"排序建议已进入 AntDesk 评审区，待用户采纳；当前顺序尚未更改。"}));
    }
    if let Some(old) = snapshot.payload["order"].as_array() {
        for id in old.iter().filter_map(Value::as_str) {
            if !order.iter().any(|item| item == id) {
                order.push(id.to_owned());
            }
        }
    }
    let mut payload = snapshot.payload.clone();
    payload["order"] = serde_json::to_value(order).map_err(error)?;
    let saved = update(&tx, snapshot.revision, payload)?;
    tx.commit().map_err(error)?;
    let _ = app.emit("planner:changed", json!({"revision": saved.revision}));
    Ok(json!({"revision": saved.revision, "tasks": queue(&saved, &todos)}))
}

pub fn serve_agent_queue(app: tauri::AppHandle) -> Result<std::net::TcpListener, String> {
    let listener = bind_queue(47833)
        .map_err(|_| "无法启动本机事项队列服务，请检查本机网络权限。")?;
    let port = listener.local_addr().map_err(error)?.port();
    QUEUE_PORT.store(port, std::sync::atomic::Ordering::Relaxed);
    listener.set_nonblocking(true).map_err(error)?;
    let accept = listener.try_clone().map_err(error)?;
    std::thread::spawn(move || loop {
        match accept.accept() {
            Ok((mut stream, _)) => {
                let app = app.clone();
                std::thread::spawn(move || {
                    let result = (|| -> Result<Value, String> {
                        stream
                            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                            .map_err(error)?;
                        stream
                            .set_write_timeout(Some(std::time::Duration::from_secs(5)))
                            .map_err(error)?;
                        let mut request = Vec::new();
                        let mut buffer = [0u8; 4096];
                        let header_end;
                        loop {
                            if request.len() >= 64 * 1024 {
                                return Err("队列请求过大。".into());
                            }
                            let count = stream.read(&mut buffer).map_err(error)?;
                            if count == 0 {
                                return Err("队列请求不完整。".into());
                            }
                            request.extend_from_slice(&buffer[..count]);
                            if let Some(end) =
                                request.windows(4).position(|window| window == b"\r\n\r\n")
                            {
                                header_end = end + 4;
                                break;
                            }
                        }
                        let headers = std::str::from_utf8(&request[..header_end])
                            .map_err(|_| "队列请求格式无效。")?;
                        let mut lines = headers.lines();
                        if lines.next().is_none_or(|line| {
                            !matches!(line, "POST / HTTP/1.1" | "POST / HTTP/1.0")
                        }) {
                            return Err("队列请求路径无效。".into());
                        }
                        let mut length = None;
                        let mut host = false;
                        let mut content_type = false;
                        let mut authorization = false;
                        let mut duplicate = HashSet::new();
                        for line in lines {
                            if let Some((name, value)) = line.split_once(':') {
                                if [
                                    "host",
                                    "content-length",
                                    "content-type",
                                    "x-antdesk-queue-token",
                                ]
                                .iter()
                                .any(|key| name.eq_ignore_ascii_case(key))
                                    && !duplicate.insert(name.to_ascii_lowercase())
                                {
                                    return Err("队列请求头重复。".into());
                                }
                                if name.eq_ignore_ascii_case("host") {
                                    if value.trim() != format!("127.0.0.1:{port}")
                                        && value.trim() != format!("localhost:{port}")
                                    {
                                        return Err("队列请求地址无效。".into());
                                    }
                                    host = true;
                                }
                                if name.eq_ignore_ascii_case("origin") {
                                    return Err("队列请求来源无效。".into());
                                }
                                if name.eq_ignore_ascii_case("content-type") {
                                    content_type =
                                        value.trim().eq_ignore_ascii_case("application/json");
                                }
                                if name.eq_ignore_ascii_case("x-antdesk-queue-token") {
                                    let actual = value.trim().as_bytes();
                                    authorization = QUEUE_TOKEN
                                        .lock()
                                        .map(|expected| {
                                            expected.len() == actual.len()
                                                && expected
                                                    .iter()
                                                    .zip(actual)
                                                    .fold(0u8, |difference, (a, b)| {
                                                        difference | (a ^ b)
                                                    })
                                                    == 0
                                        })
                                        .unwrap_or(false)
                                        && !actual.is_empty();
                                }
                                if name.eq_ignore_ascii_case("content-length") {
                                    length = value.trim().parse::<usize>().ok();
                                }
                            }
                        }
                        if !host || !content_type || !authorization {
                            return Err("队列请求未通过本机身份验证。".into());
                        }
                        let length = length
                            .filter(|length| *length <= 64 * 1024)
                            .ok_or("队列请求容量无效。")?;
                        while request.len() < header_end + length {
                            let count = stream.read(&mut buffer).map_err(error)?;
                            if count == 0 {
                                return Err("队列请求不完整。".into());
                            }
                            request.extend_from_slice(&buffer[..count]);
                        }
                        let input: Value =
                            serde_json::from_slice(&request[header_end..header_end + length])
                                .map_err(|_| "队列请求格式无效。")?;
                        let name = input["name"].as_str().ok_or("队列工具名称无效。")?;
                        task_hub_agent_queue(app, name.to_owned(), input["arguments"].clone())
                    })();
                    let (status, body) = match result {
                        Ok(mut value) => {
                            value["service"] = json!("antdesk-planner");
                            value["version"] = json!(1);
                            (200, value)
                        }
                        Err(message) => (
                            if message.starts_with("QUEUE_CONFLICT:") {
                                409
                            } else {
                                400
                            },
                            json!({"service":"antdesk-planner","version":1,"error":{"code":if message.starts_with("QUEUE_CONFLICT:"){"queue_conflict"}else{"invalid_request"},"message":message}}),
                        ),
                    };
                    let body = body.to_string();
                    let _ = stream.write_all(format!("HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes());
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(100))
            }
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(250)),
        }
    });
    Ok(listener)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn occupied_queue_port_falls_back_to_an_available_loopback_port() {
        let occupied = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let preferred = occupied.local_addr().unwrap().port();
        let fallback = bind_queue(preferred).unwrap();
        assert_ne!(fallback.local_addr().unwrap().port(), preferred);
        assert!(fallback.local_addr().unwrap().ip().is_loopback());
    }

    #[test]
    fn mcp_arguments_use_the_advertised_snake_case_schema() {
        let request: AgentQueueRequest = serde_json::from_value(json!({
            "expected_revision":4,"ordered_task_ids":["local:a"]
        }))
        .unwrap();
        assert_eq!(request.expected_revision, 4);
        assert_eq!(request.ordered_task_ids, vec!["local:a"]);
        assert!(serde_json::from_value::<AgentQueueRequest>(json!({
            "expected_revision":4,"ordered_task_ids":[],"unexpected":true
        }))
        .is_err());
    }

    #[test]
    fn assistant_queue_reorders_inside_one_transaction() {
        let mut c = Connection::open_in_memory().unwrap();
        let snapshot = HubSnapshot {
            revision: 0,
            payload: json!({"order":["local:a","local:b"]}),
        };
        let payload = json!({"order":["local:b","local:a"]});
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let saved = update(&tx, snapshot.revision, payload).unwrap();
        tx.commit().unwrap();
        assert_eq!(saved.revision, 1);
        assert_eq!(
            load(&c).unwrap().payload["order"],
            json!(["local:b", "local:a"])
        );
    }

    #[test]
    fn assistant_queue_uses_manual_order_and_active_queue_projection() {
        let snapshot = HubSnapshot {
            revision: 4,
            payload: json!({"order":["local:c","local:b","local:a"]}),
        };
        let tasks = queue(
            &snapshot,
            &[
                json!({"id":"local:a","title":"A"}),
                json!({"id":"local:c","title":"C"}),
            ],
        );
        assert_eq!(tasks[0]["id"], "local:c");
        assert_eq!(tasks[1]["id"], "local:a");
        assert_eq!(tasks.len(), 2);
    }

    #[test]
    fn saves_and_reads_exact_snapshot_without_touching_other_tables() {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE journal(text TEXT); INSERT INTO journal VALUES('keep');")
            .unwrap();
        assert_eq!(
            load(&c).unwrap(),
            HubSnapshot {
                revision: 0,
                payload: json!({})
            }
        );
        let payload = json!({"schemaVersion":1,"localTasks":[{"id":"local:a","title":"核对方案"}],"order":["local:a"]});
        let saved = save(&mut c, 0, payload.clone()).unwrap();
        assert_eq!(saved.revision, 1);
        assert_eq!(load(&c).unwrap(), saved);
        assert_eq!(
            c.query_row("SELECT text FROM journal", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "keep"
        );
    }

    #[test]
    fn stale_revision_cannot_replace_new_plan() {
        let mut c = Connection::open_in_memory().unwrap();
        save(&mut c, 0, json!({"order":["b","a"]})).unwrap();
        let failed = save(&mut c, 0, json!({"order":["a","b"]})).unwrap_err();
        assert!(failed.starts_with("TASK_HUB_CONFLICT:"));
        assert_eq!(load(&c).unwrap().payload["order"], json!(["b", "a"]));
        assert_eq!(load(&c).unwrap().revision, 1);
    }

    #[test]
    fn rejects_invalid_or_oversized_payload_without_mutating_state() {
        let mut c = Connection::open_in_memory().unwrap();
        load(&c).unwrap();
        assert!(save(&mut c, 0, json!([])).is_err());
        assert!(save(&mut c, 0, json!({"note":"x".repeat(MAX_PAYLOAD_BYTES)})).is_err());
        assert!(save(&mut c, u64::MAX, json!({})).is_err());
        assert_eq!(load(&c).unwrap().revision, 0);
    }

    #[test]
    fn durable_snapshot_survives_reopen_and_cross_connection_conflict() {
        let path = std::env::temp_dir().join(format!(
            "antdesk-hub-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        {
            let mut a = Connection::open(&path).unwrap();
            let mut b = Connection::open(&path).unwrap();
            let stale = load(&a).unwrap();
            save(&mut b, 0, json!({"focusId":"local:one"})).unwrap();
            assert!(save(&mut a, stale.revision, json!({"focusId":"local:two"})).is_err());
        }
        let c = Connection::open(&path).unwrap();
        assert_eq!(load(&c).unwrap().payload["focusId"], "local:one");
        drop(c);
        std::fs::remove_file(path).unwrap();
    }
}
