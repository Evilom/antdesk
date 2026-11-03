use super::*;

fn request() -> StartRunRequest {
    StartRunRequest { idempotency_key:"native-one".into(),task_id:"task-one".into(),title:"原生事项".into(),instruction:"处理已提供材料".into(),
        profile:AgentProfile{id:"omdot-profile".into(),name:"omdot".into(),endpoint:"http://127.0.0.1:47631".into(),model:String::new(),protocol:"dots-mcp".into(),agent_ref:"omdot".into(),webhook_url:String::new(),session_id:None},context:None,parent_run_id:None }
}
fn snapshot(run: &AgentRun, status: &str, at: i64) -> Snapshot {
    Snapshot {id:run.id.clone(),status:status.into(),delivery_status:"accepted".into(),progress:"进度内容".into(),result:if status=="review"{"真实交付".into()}else{String::new()},error:String::new(),updated_at:at,..Snapshot::default()}
}
fn begin(c: &mut Connection) -> AgentRun {
    let (run, _) = enqueue(c, &request()).unwrap();
    assert!(mark_running(c, &run.id).unwrap()); assert!(prepare_dispatch(c, &run.id).unwrap());
    get(c, &run.id).unwrap()
}
#[test]
fn migration_preserves_old_runs_and_unrelated_planner_data() {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE assistant_runs (
      id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,task_id TEXT NOT NULL,title TEXT NOT NULL,instruction TEXT NOT NULL,
      agent_id TEXT NOT NULL,agent_name TEXT NOT NULL,status TEXT NOT NULL,result TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,parent_run_id TEXT,review_decision TEXT,reviewed_at INTEGER,request_fingerprint TEXT NOT NULL);
      INSERT INTO assistant_runs VALUES('old','old-key','old-task','旧事项','旧要求','old-agent','旧助理','review','历史结果','',1,2,NULL,'accepted',2,'fingerprint');
      CREATE TABLE planner_state (value TEXT); INSERT INTO planner_state VALUES('user-data-untouched');").unwrap();
    init(&c).unwrap(); init(&c).unwrap();
    let old = get(&c, "old").unwrap();
    assert_eq!(old.result, "历史结果"); assert_eq!(old.protocol, "openai");
    assert_eq!(c.query_row("SELECT value FROM planner_state",[],|r|r.get::<_,String>(0)).unwrap(),"user-data-untouched");
}
#[test]
fn accepted_and_progress_are_not_completion_and_cancel_beats_late_reply() {
    let mut c = Connection::open_in_memory().unwrap();
    let run = begin(&mut c);
    assert_eq!(run.external_run_id.as_deref(),Some(run.id.as_str()));
    apply_remote(&c,&run.id,&snapshot(&run,"running",100)).unwrap();
    let pending = get(&c,&run.id).unwrap();
    assert_eq!(pending.status,"running"); assert!(pending.result.is_empty()); assert_eq!(pending.progress,"进度内容");
    cancel(&c,&run.id).unwrap();
    assert!(!apply_remote(&c,&run.id,&snapshot(&run,"review",101)).unwrap());
    assert_eq!(get(&c,&run.id).unwrap().status,"cancelled");
}
#[test]
fn native_restart_blocks_duplicate_dispatch_until_original_is_resolved() {
    let mut c = Connection::open_in_memory().unwrap();
    let run = begin(&mut c);
    assert_eq!(recover(&c).unwrap(),1);
    let stopped = get(&c,&run.id).unwrap();
    assert_eq!(stopped.status,"interrupted"); assert!(stopped.external_run_id.is_some());
    assert_eq!(route(&c,&run.id).unwrap().agent_ref,"omdot");
    let mut duplicate = request(); duplicate.idempotency_key="different-key".into();
    assert!(enqueue(&mut c,&duplicate).is_err());
    apply_remote(&c,&run.id,&snapshot(&run,"review",200)).unwrap();
    assert_eq!(get(&c,&run.id).unwrap().result,"真实交付");
    assert!(enqueue(&mut c,&duplicate).is_ok());
}
#[test]
fn stale_snapshots_cannot_regress_progress_and_stop_following_releases_task() {
    let mut c = Connection::open_in_memory().unwrap();
    let run = begin(&mut c);
    let mut newer = snapshot(&run,"running",200); newer.progress="已完成两步".into();
    apply_remote(&c,&run.id,&newer).unwrap();
    assert!(!apply_remote(&c,&run.id,&snapshot(&run,"running",100)).unwrap());
    assert_eq!(get(&c,&run.id).unwrap().progress,"已完成两步");
    interrupt(&c,&run.id,"连接中断").unwrap(); cancel(&c,&run.id).unwrap();
    let mut next = request(); next.idempotency_key="after-stop".into();
    assert!(enqueue(&mut c,&next).is_ok());
}

#[test]
fn definitive_rejection_releases_task_but_ambiguous_delivery_keeps_it_reserved() {
    let mut c = Connection::open_in_memory().unwrap();
    let run = begin(&mut c);
    assert!(reject_dispatch(&c,&run.id,"尚未订阅").unwrap());
    let rejected = get(&c,&run.id).unwrap();
    assert_eq!(rejected.status,"failed"); assert_eq!(rejected.delivery_status,"rejected"); assert!(rejected.external_run_id.is_none());
    let mut next = request(); next.idempotency_key="after-fix".into();
    let (second,_) = enqueue(&mut c,&next).unwrap();
    mark_running(&c,&second.id).unwrap(); prepare_dispatch(&c,&second.id).unwrap();
    interrupt(&c,&second.id,"POST响应丢失").unwrap();
    assert_eq!(get(&c,&second.id).unwrap().delivery_status,"unknown");
    next.idempotency_key="must-not-repeat".into();
    assert!(enqueue(&mut c,&next).is_err());
}

#[test]
fn cancellation_before_dispatch_is_atomic_against_creating_an_external_handle() {
    let mut c=Connection::open_in_memory().unwrap();
    let (run,_)=enqueue(&mut c,&request()).unwrap();
    mark_running(&c,&run.id).unwrap();
    let cancelled=cancel_before_dispatch(&c,&run.id).unwrap().unwrap();
    assert_eq!(cancelled.status,"cancelled");assert!(cancelled.external_run_id.is_none());
    assert!(!prepare_dispatch(&c,&run.id).unwrap());
    let mut next=request();next.idempotency_key="after-local-cancel".into();
    let (started,_)=enqueue(&mut c,&next).unwrap();
    mark_running(&c,&started.id).unwrap();prepare_dispatch(&c,&started.id).unwrap();
    assert!(cancel_before_dispatch(&c,&started.id).unwrap().is_none());
    assert_eq!(get(&c,&started.id).unwrap().status,"running");
}
#[test]
fn failed_remote_close_remains_retryable_and_acknowledged_close_releases_the_task() {
    let mut c=Connection::open_in_memory().unwrap();
    let run=begin(&mut c);
    interrupt(&c,&run.id,"缺少桥接密钥，停止跟进尚未确认").unwrap();
    worker_stopped(&c,&run.id).unwrap();
    let mut next=request();next.idempotency_key="retry-after-connection".into();
    assert!(enqueue(&mut c,&next).is_err());
    let acknowledged=confirm_bridge_close(&c,&run.id,&snapshot(&run,"cancelled",200)).unwrap();
    assert_eq!(acknowledged.status,"cancelled");assert!(acknowledged.external_run_id.is_none());
    worker_stopped(&c,&run.id).unwrap();
    assert_eq!(get(&c,&run.id).unwrap().status,"cancelled");
    assert!(enqueue(&mut c,&next).is_ok());
}
#[test]
fn cancellation_keeps_a_result_that_the_bridge_already_finished() {
    let mut c=Connection::open_in_memory().unwrap();
    let run=begin(&mut c);
    interrupt(&c,&run.id,"请求停止跟进").unwrap();
    let finished=confirm_bridge_close(&c,&run.id,&snapshot(&run,"review",300)).unwrap();
    assert_eq!(finished.status,"review");assert_eq!(finished.result,"真实交付");
    worker_stopped(&c,&run.id).unwrap();
    assert_eq!(get(&c,&run.id).unwrap().result,"真实交付");
    assert_eq!(get(&c,&run.id).unwrap().status,"review");
}

#[test]
fn close_confirmation_requires_a_closed_bridge_record() {
    let mut c=Connection::open_in_memory().unwrap();
    let run=begin(&mut c);interrupt(&c,&run.id,"请求停止跟进").unwrap();
    for status in ["queued","running","interrupted"] {
        assert!(confirm_bridge_close(&c,&run.id,&snapshot(&run,status,300)).is_err());
        let waiting=get(&c,&run.id).unwrap();
        assert_eq!(waiting.status,"interrupted");assert!(waiting.external_run_id.is_some());
    }
}
#[test]
fn explicit_legacy_close_can_recover_real_results_without_enabling_late_poll_updates() {
    for status in ["review","failed"] {
        let mut c=Connection::open_in_memory().unwrap();
        let run=begin(&mut c);cancel(&c,&run.id).unwrap();
        let remote=snapshot(&run,status,400);
        assert!(!apply_remote(&c,&run.id,&remote).unwrap());
        let recovered=confirm_bridge_close(&c,&run.id,&remote).unwrap();
        assert_eq!(recovered.status,status);
        if status=="review" { assert_eq!(recovered.result,"真实交付"); }
        else { assert!(!recovered.error.is_empty()); }
        worker_stopped(&c,&run.id).unwrap();assert_eq!(get(&c,&run.id).unwrap().status,status);
    }
}

#[test]
fn all_installed_protocols_reserve_uncertain_dispatch_and_recover_without_resubmission() {
    for protocol in ["grok-direct", "dots-direct", "muse-code", "deepseek-harness", "muse-personal", "notion-web"] {
        let mut c = Connection::open_in_memory().unwrap();
        let mut input = request(); input.profile.protocol = protocol.into(); input.profile.session_id = Some("selected-session".into());
        let (run, _) = enqueue(&mut c, &input).unwrap();
        assert_eq!(run.session_id.as_deref(), Some("selected-session"));
        assert!(mark_running(&c, &run.id).unwrap()); assert!(prepare_dispatch(&c, &run.id).unwrap());
        interrupt(&c, &run.id, "响应丢失").unwrap();
        assert_eq!(get(&c, &run.id).unwrap().delivery_status, "unknown");
        input.idempotency_key = "must-not-replay".into(); assert!(enqueue(&mut c, &input).is_err());
        assert!(!prepare_dispatch(&c, &run.id).unwrap());
        assert_eq!(route(&c, &run.id).unwrap().session_id.as_deref(), Some("selected-session"));
        let mut remote = snapshot(&run, "running", 400); remote.session_id = Some("selected-session".into());
        apply_remote(&c, &run.id, &remote).unwrap(); recover(&c).unwrap();
        assert!(enqueue(&mut c, &input).is_err());
        remote.status = "cancelled".into(); remote.updated_at = 500; remote.remote_stopped = Some(true);
        let cancelled = confirm_bridge_close(&c, &run.id, &remote).unwrap();
        assert_eq!(cancelled.remote_stopped, Some(true)); assert!(cancelled.error.is_empty());
        assert!(enqueue(&mut c, &input).is_ok());
    }
}

#[test]
fn structured_runtime_state_survives_reopen_and_attention_can_be_cleared() {
    let path = std::env::temp_dir().join(format!("antdesk-runtime-state-{}-{}.sqlite", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let id;
    {
        let mut c = Connection::open(&path).unwrap();
        let mut input = request(); input.profile.protocol = "deepseek-harness".into();
        let (run, _) = enqueue(&mut c, &input).unwrap(); id = run.id.clone(); mark_running(&c, &id).unwrap(); prepare_dispatch(&c, &id).unwrap();
        let mut remote = snapshot(&run, "running", 100);
        remote.session_id = Some("session-kept".into()); remote.turn_id = Some("turn-kept".into()); remote.cursor = Some("cursor-kept".into());
        remote.attention = Some(serde_json::from_value(serde_json::json!({"id":"input-1","kind":"input","title":"请选择材料","fields":[{"id":"file","label":"材料","required":true,"secret":false}]})).unwrap());
        remote.messages = vec![serde_json::from_value(serde_json::json!({"id":"message-1","role":"assistant","text":"需要确认材料","complete":false,"updatedAt":100})).unwrap()];
        assert!(apply_remote(&c, &id, &remote).unwrap()); recover(&c).unwrap();
    }
    {
        let c = Connection::open(&path).unwrap(); init(&c).unwrap();
        let saved = get(&c, &id).unwrap();
        assert_eq!(saved.status, "interrupted"); assert_eq!(saved.session_id.as_deref(), Some("session-kept"));
        assert_eq!(saved.turn_id.as_deref(), Some("turn-kept")); assert_eq!(saved.cursor.as_deref(), Some("cursor-kept"));
        assert_eq!(saved.attention.as_ref().unwrap().fields.as_ref().unwrap()[0].required, Some(true));
        assert_eq!(saved.messages[0].text, "需要确认材料");
        let mut remote = snapshot(&saved, "running", 100);
        remote.messages = saved.messages.clone(); remote.messages[0].complete = Some(true);
        assert!(apply_remote(&c, &id, &remote).unwrap());
        let cleared = get(&c, &id).unwrap(); assert!(cleared.attention.is_none()); assert_eq!(cleared.messages[0].complete, Some(true));
        assert_eq!(cleared.session_id.as_deref(), Some("session-kept"));
    }
    std::fs::remove_file(path).unwrap();
}
