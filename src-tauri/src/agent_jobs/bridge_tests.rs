use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn profile(endpoint: &str, protocol: &str) -> AgentProfile {
    AgentProfile { id: "local-profile".into(), name: "私人助理".into(), endpoint: endpoint.into(),
        model: String::new(), protocol: protocol.into(), agent_ref: "omdot".into(),
        webhook_url: if protocol == "grok-webhook" { "https://hooks.example.test/routine/one".into() } else { String::new() }, session_id:None }
}
async fn read(socket: &mut tokio::net::TcpStream) -> String {
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut bytes = Vec::new();
        loop {
            let mut chunk = [0u8; 4096];
            let n = socket.read(&mut chunk).await.unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&chunk[..n]);
            if let Some(start) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..start]);
                let length = headers.lines().filter_map(|line| line.split_once(':'))
                    .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                    .map(|(_, n)| n.trim().parse::<usize>().unwrap()).unwrap_or(0);
                if bytes.len() >= start + 4 + length { return String::from_utf8(bytes).unwrap(); }
            }
        }
    }).await.unwrap()
}
async fn reply(socket: &mut tokio::net::TcpStream, status: u16, body: Value) {
    let body = body.to_string();
    socket.write_all(format!("HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).as_bytes()).await.unwrap();
}
fn snapshot(id: &str, state: &str, at: i64) -> Value {
    json!({"id":id,"status":state,"deliveryStatus":"accepted","progress":"","result":if state=="review"{"实际结果"}else{""},"error":"","updatedAt":at})
}
#[test]
fn validates_native_routes_without_a_model_and_rejects_unsafe_addresses() {
    let mut p = profile("http://127.0.0.1:47631", "grok-webhook");
    assert!(validate_profile(&p).is_ok());
    p.endpoint = "http://192.168.1.2:47631".into(); assert!(validate_profile(&p).is_err());
    p.endpoint = "https://bridge.example.test/?token=hidden".into(); assert!(validate_profile(&p).is_err());
    p.endpoint = "https://user:pass@bridge.example.test".into(); assert!(validate_profile(&p).is_err());
    p.endpoint = "https://bridge.example.test".into(); p.webhook_url = "http://127.0.0.1/webhook".into(); assert!(validate_profile(&p).is_err());
    p.webhook_url = "https://hooks.example.test/routine".into(); p.agent_ref = "../another".into(); assert!(validate_profile(&p).is_err());
    assert!(validate_profile(&profile("http://[::1]:47631", "dots-mcp")).is_ok());
}
#[tokio::test]
async fn native_probe_reads_status_without_starting_a_bot_or_using_a_model() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = read(&mut socket).await;
        assert!(request.starts_with("GET /api/status?agentId=omdot&protocol=dots-mcp"));
        assert!(request.to_lowercase().contains("authorization: bearer bridge-session-secret"));
        reply(&mut socket, 200, json!({"service":"antdesk-native-bridge","version":1,"agentId":"omdot","protocol":"dots-mcp","ready":false,"readiness":"needs_subscription","subscriptionCount":0})).await;
    });
    let p = profile(&format!("http://{address}"), "dots-mcp");
    let checked = Client::new(&p, Some("bridge-session-secret")).unwrap().probe(&p).await.unwrap();
    assert!(!checked.ok); assert_eq!(checked.readiness.as_deref(), Some("needs_subscription"));
    assert!(checked.message.contains("订阅")); server.await.unwrap();
}
#[tokio::test]
async fn native_dispatch_and_poll_only_complete_on_a_real_review_result() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        for step in 0..3 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read(&mut socket).await;
            if step == 0 {
                assert!(request.starts_with("POST /api/runs"));
                let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
                assert_eq!(body["id"], "run-1"); assert_eq!(body["agentId"], "omdot");
                assert_eq!(body["protocol"], "grok-webhook"); assert_eq!(body["webhookKey"], "webhook-session-secret");
                assert!(body.get("model").is_none());
            } else { assert!(request.starts_with("GET /api/runs/run-1")); }
            let mut data = snapshot("run-1", if step == 2 { "review" } else { "running" }, 100 + step);
            if step == 1 { data["progress"] = json!("正在整理资料"); }
            reply(&mut socket, 200, data).await;
        }
    });
    let p = profile(&format!("http://{address}"), "grok-webhook");
    let client = Client::new(&p, Some("bridge-session-secret")).unwrap();
    let request = StartRunRequest { idempotency_key:"once".into(),task_id:"task-1".into(),title:"整理资料".into(),instruction:"整理所提供资料".into(),profile:p,context:None,parent_run_id:None };
    let accepted = client.submit("run-1", &request, Some("webhook-session-secret")).await.unwrap();
    assert!(!accepted.is_terminal()); assert!(accepted.result.is_empty());
    let progress = client.get("run-1").await.unwrap();
    assert!(!progress.is_terminal()); assert_eq!(progress.progress, "正在整理资料");
    let result = client.get("run-1").await.unwrap();
    assert!(result.is_terminal()); assert_eq!(result.result, "实际结果");
    server.await.unwrap();
}
#[tokio::test]
async fn ambiguous_post_failure_is_not_automatically_retried() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap(); read(&mut socket).await; drop(socket);
        assert!(tokio::time::timeout(Duration::from_millis(300), listener.accept()).await.is_err());
    });
    let p = profile(&format!("http://{address}"), "grok-webhook");
    let client = Client::new(&p, Some("bridge-session-secret")).unwrap();
    let request = StartRunRequest { idempotency_key:"once".into(),task_id:"task-1".into(),title:"整理资料".into(),instruction:"整理所提供资料".into(),profile:p,context:None,parent_run_id:None };
    assert!(!client.submit("run-1", &request, Some("webhook-session-secret")).await.unwrap_err().definitive);
    server.await.unwrap();
}
#[tokio::test]
async fn bridge_errors_do_not_echo_secrets_and_redirects_are_not_followed() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap(); read(&mut socket).await;
        socket.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/private\r\nContent-Length: 29\r\nConnection: close\r\n\r\nbridge-session-secret-webhook").await.unwrap();
    });
    let p = profile(&format!("http://{address}"), "dots-mcp");
    let client = Client::new(&p, Some("bridge-session-secret")).unwrap();
    let error = client.get("run-1").await.unwrap_err();
    assert!(error.contains("302")); assert!(!error.contains("secret")); server.await.unwrap();
}
#[test]
fn mismatched_or_empty_final_results_cannot_complete_work() {
    let p = profile("http://127.0.0.1:47631", "dots-mcp");
    let client = Client::new(&p, Some("bridge-session-secret")).unwrap();
    assert!(client.snapshot(snapshot("other", "review", 1), "expected", None).is_err());
    let mut empty = snapshot("run-1", "review", 1); empty["result"] = json!("");
    assert!(client.snapshot(empty, "run-1", None).is_err());
    let mut leaked = snapshot("run-1", "review", 1); leaked["result"] = json!("bridge-session-secret");
    assert!(!client.snapshot(leaked, "run-1", None).unwrap().result.contains("bridge-session-secret"));
}

#[tokio::test]
async fn rejected_dispatch_is_typed_and_never_echoes_response_secrets() {
    for status in [400, 401, 403, 404, 405, 409, 413, 415, 422, 429] {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap(); read(&mut socket).await;
        reply(&mut socket,status,json!({"error":{"code":"subscription_required","message":"bridge-session-secret must not be shown"}})).await;
    });
    let p = profile(&format!("http://{address}"), "dots-mcp");
    let client = Client::new(&p, Some("bridge-session-secret")).unwrap();
    let request = StartRunRequest { idempotency_key:"once".into(),task_id:"task-1".into(),title:"整理资料".into(),instruction:"整理所提供资料".into(),profile:p,context:None,parent_run_id:None };
    let error = client.submit("run-1",&request,None).await.unwrap_err();
    assert!(error.definitive, "HTTP {status} must be a definitive rejection"); assert!(!error.message.contains("secret")); server.await.unwrap();
    }
}

#[tokio::test]
async fn cancelling_an_already_finished_bridge_run_returns_its_real_result() {
    let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address=listener.local_addr().unwrap();
    let server=tokio::spawn(async move {
        let (mut socket,_)=listener.accept().await.unwrap();
        assert!(read(&mut socket).await.starts_with("POST /api/runs/run-1/cancel"));
        reply(&mut socket,200,snapshot("run-1","review",100)).await;
    });
    let p=profile(&format!("http://{address}"),"dots-mcp");
    let value=Client::new(&p,Some("bridge-session-secret")).unwrap().cancel("run-1").await.unwrap();
    assert_eq!(value.status,"review");assert_eq!(value.result,"实际结果");
    server.await.unwrap();
}

#[test]
fn installed_runtimes_only_accept_the_fixed_local_bridge_and_explicit_bot_ids() {
    for protocol in ["grok-direct", "dots-direct", "muse-code", "deepseek-harness", "muse-personal", "notion-web"] {
        let mut p = profile("http://127.0.0.1:47631", protocol);
        p.session_id = Some("existing-session".into());
        assert!(validate_profile(&p).is_ok());
        p.endpoint = "https://other.example.test".into();
        assert!(validate_profile(&p).is_err());
        assert!(Client::new(&p, Some("private-key")).is_err());
    }
    let mut p = profile("http://127.0.0.1:47631", "grok-direct");
    p.agent_ref.clear(); assert!(validate_profile(&p).is_err());
    let mut dotted = profile("http://127.0.0.1:47631", "dots-direct");
    dotted.agent_ref = "dot~one".into();
    assert!(validate_profile(&dotted).is_ok());
    let encoded = serde_json::to_value(profile("http://127.0.0.1:47631", "dots-mcp")).unwrap();
    assert!(encoded.get("sessionId").is_none(), "Old request fingerprints must not gain a null session field");
    let mut with_empty_session = encoded.clone(); with_empty_session["sessionId"] = json!("");
    let decoded: AgentProfile = serde_json::from_value(with_empty_session).unwrap();
    assert!(decoded.session_id.is_none()); assert_eq!(serde_json::to_value(decoded).unwrap(), encoded);
}

#[tokio::test]
async fn runtime_probe_is_read_only_and_dispatch_preserves_the_selected_session() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        assert!(read(&mut socket).await.starts_with("GET /api/runtime/providers "));
        reply(&mut socket, 200, json!({"providers":[{"id":"muse-code","protocol":"muse-code","readiness":"needs_login","official":true,"message":"请登录"}]})).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = read(&mut socket).await;
        assert!(request.starts_with("POST /api/runs "));
        let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["sessionId"], "session-existing"); assert_eq!(body["protocol"], "muse-code");
        assert!(body.get("webhookKey").is_none()); assert!(body.get("model").is_none());
        let mut value = snapshot("run-runtime", "running", 300);
        value["sessionId"] = json!("session-existing"); value["turnId"] = json!("turn-1"); value["cursor"] = json!("event-1");
        value["attention"] = json!({"id":"approval-1","kind":"approval","title":"允许读取材料？","description":"private-key","options":[{"id":"allow","label":"允许"}]});
        value["messages"] = json!([{"id":"message-1","role":"assistant","text":"private-key","complete":false,"updatedAt":300}]);
        reply(&mut socket, 202, value).await;
    });
    let mut p = profile("http://127.0.0.1:47631", "muse-code"); p.session_id = Some("session-existing".into());
    let mut client = Client::new(&p, Some("private-key")).unwrap();
    // Only the private test client is retargeted; production construction rejects other ports.
    client.base = Url::parse(&format!("http://{address}")).unwrap();
    let probe = client.probe(&p).await.unwrap(); assert!(!probe.ok); assert_eq!(probe.readiness.as_deref(), Some("needs_login"));
    let request = StartRunRequest { idempotency_key:"once".into(),task_id:"task-1".into(),title:"整理资料".into(),instruction:"整理所提供资料".into(),profile:p,context:None,parent_run_id:None };
    let run = client.submit("run-runtime", &request, None).await.unwrap();
    assert_eq!(run.session_id.as_deref(), Some("session-existing")); assert_eq!(run.turn_id.as_deref(), Some("turn-1"));
    assert_eq!(run.cursor.as_deref(), Some("event-1")); assert_eq!(run.attention.as_ref().unwrap().kind, "approval");
    assert!(!run.attention.unwrap().description.unwrap().contains("private-key"));
    assert!(!run.messages[0].text.contains("private-key")); server.await.unwrap();
}

#[test]
fn runtime_snapshot_rejects_unrecognized_attention_and_message_roles() {
    let p = profile("http://127.0.0.1:47631", "muse-code");
    let client = Client::new(&p, Some("private-key")).unwrap();
    let mut value = snapshot("run-1", "running", 1);
    value["attention"] = json!({"id":"a","kind":"execute-arbitrary-url","title":"unsafe"});
    assert!(client.snapshot(value, "run-1", None).is_err());
    let mut value = snapshot("run-1", "running", 1);
    value["messages"] = json!([{"id":"m","role":"administrator","text":"invalid"}]);
    assert!(client.snapshot(value, "run-1", None).is_err());
}
