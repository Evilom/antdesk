use super::{now_ms, AgentProfile, AgentRun, StartRunRequest};
use super::bridge::Snapshot;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};

const COLUMNS: &str = "id,idempotency_key,task_id,title,instruction,agent_id,agent_name,status,result,error,created_at,updated_at,parent_run_id,review_decision,reviewed_at,protocol,progress,delivery_status,external_run_id,session_id,turn_id,event_cursor,attention_json,messages_json,remote_stopped";

fn error(e: impl std::fmt::Display) -> String { format!("助理记录存储失败：{e}") }

pub(super) fn init(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS assistant_runs (
      id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL, title TEXT NOT NULL, instruction TEXT NOT NULL,
      agent_id TEXT NOT NULL, agent_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN('queued','running','review','failed','cancelled','interrupted')),
      result TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      parent_run_id TEXT, review_decision TEXT CHECK(review_decision IN('accepted','rejected')), reviewed_at INTEGER,
      request_fingerprint TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS assistant_runs_updated ON assistant_runs(updated_at);
      CREATE INDEX IF NOT EXISTS assistant_runs_parent ON assistant_runs(parent_run_id);
      CREATE UNIQUE INDEX IF NOT EXISTS assistant_runs_active_task ON assistant_runs(task_id) WHERE status IN('queued','running');")
        .map_err(error)?;
    // Additive migration preserves existing run history and the independent planner_state.
    let columns = {
        let mut stmt = c.prepare("PRAGMA table_info(assistant_runs)").map_err(error)?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(1)).map_err(error)?;
        rows.collect::<Result<std::collections::HashSet<_>, _>>().map_err(error)?
    };
    for (name, definition) in [
        ("protocol", "TEXT NOT NULL DEFAULT 'openai'"),
        ("progress", "TEXT NOT NULL DEFAULT ''"),
        ("delivery_status", "TEXT NOT NULL DEFAULT ''"),
        ("external_run_id", "TEXT"),
        ("route_json", "TEXT NOT NULL DEFAULT ''"),
        ("remote_updated_at", "INTEGER NOT NULL DEFAULT 0"),
        ("session_id", "TEXT"),
        ("turn_id", "TEXT"),
        ("event_cursor", "TEXT"),
        ("attention_json", "TEXT"),
        ("messages_json", "TEXT NOT NULL DEFAULT '[]'"),
        ("remote_stopped", "INTEGER"),
    ] {
        if !columns.contains(name) { c.execute_batch(&format!("ALTER TABLE assistant_runs ADD COLUMN {name} {definition};")).map_err(error)?; }
    }
    c.execute_batch("CREATE UNIQUE INDEX IF NOT EXISTS assistant_runs_native_active_task_v5
      ON assistant_runs(task_id) WHERE status IN('queued','running') OR
      (status='interrupted' AND protocol IN('grok-webhook','dots-mcp','grok-direct','dots-direct','muse-code','deepseek-harness','muse-personal','notion-web') AND external_run_id IS NOT NULL);").map_err(error)
}

fn json_column<T: serde::de::DeserializeOwned>(r: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<T> {
    let raw: String = r.get(index)?;
    serde_json::from_str(&raw).map_err(|error| rusqlite::Error::FromSqlConversionFailure(index, rusqlite::types::Type::Text, Box::new(error)))
}

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<AgentRun> {
    Ok(AgentRun {
        id:r.get(0)?, idempotency_key:r.get(1)?, task_id:r.get(2)?, title:r.get(3)?,
        instruction:r.get(4)?, agent_id:r.get(5)?, agent_name:r.get(6)?, status:r.get(7)?,
        result:r.get(8)?, error:r.get(9)?, created_at:r.get(10)?, updated_at:r.get(11)?,
        parent_run_id:r.get(12)?, review_decision:r.get(13)?, reviewed_at:r.get(14)?,
        protocol:r.get(15)?, progress:r.get(16)?, delivery_status:r.get(17)?, external_run_id:r.get(18)?,
        session_id:r.get(19)?, turn_id:r.get(20)?, cursor:r.get(21)?,
        attention: if r.get::<_, Option<String>>(22)?.is_some() { json_column(r,22)? } else { None },
        messages:json_column(r,23)?, remote_stopped:r.get(24)?,
    })
}

pub(super) fn get(c:&Connection, id:&str) -> Result<AgentRun,String> {
    c.query_row(&format!("SELECT {COLUMNS} FROM assistant_runs WHERE id=?1"), [id], row)
        .optional().map_err(error)?.ok_or_else(|| "找不到这次助理执行记录。".into())
}

pub(super) fn list(c:&Connection) -> Result<Vec<AgentRun>,String> {
    init(c)?;
    let mut s=c.prepare(&format!("SELECT {COLUMNS} FROM assistant_runs ORDER BY CASE WHEN status IN('queued','running') OR (status='interrupted' AND external_run_id IS NOT NULL) THEN 0 WHEN status='review' AND review_decision IS NULL THEN 1 ELSE 2 END,updated_at DESC,id DESC LIMIT 500")).map_err(error)?;
    let rows=s.query_map([],row).map_err(error)?;
    rows.collect::<Result<Vec<_>,_>>().map_err(error)
}

/// One transaction owns idempotency, active-task exclusion and queue admission.
pub(super) fn enqueue(c:&mut Connection, request:&StartRunRequest) -> Result<(AgentRun,bool),String> {
    init(c)?;
    let fingerprint=format!("{:x}",Sha256::digest(serde_json::to_vec(request).map_err(error)?));
    let tx=c.transaction_with_behavior(TransactionBehavior::Immediate).map_err(error)?;
    let prior:Option<(String,String)>=tx.query_row("SELECT id,request_fingerprint FROM assistant_runs WHERE idempotency_key=?1", [&request.idempotency_key], |r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(error)?;
    if let Some((id,old))=prior {
        if old!=fingerprint { return Err("这次操作编号已用于不同任务，请重新发起。".into()); }
        let run=get(&tx,&id)?;
        tx.commit().map_err(error)?;
        return Ok((run,false));
    }
    if let Some(parent_id)=&request.parent_run_id {
        let parent=get(&tx,parent_id)?;
        if parent.task_id!=request.task_id || parent.status!="review" || parent.result.trim().is_empty() {
            return Err("接力来源必须是同一事项已经交回的结果。".into());
        }
    }
    let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM assistant_runs WHERE task_id=?1 AND (status IN('queued','running') OR (status='interrupted' AND protocol IN('grok-webhook','dots-mcp','grok-direct','dots-direct','muse-code','deepseek-harness','muse-personal','notion-web') AND external_run_id IS NOT NULL)))", [&request.task_id], |r|r.get(0)).map_err(error)?;
    if active { return Err("这件事已有助理正在处理或等待确认；请同步原执行、停止跟进，或等待结果后接力。".into()); }
    let queued:i64=tx.query_row("SELECT count(*) FROM assistant_runs WHERE status IN('queued','running') OR (status='interrupted' AND protocol IN('grok-webhook','dots-mcp','grok-direct','dots-direct','muse-code','deepseek-harness','muse-personal','notion-web') AND external_run_id IS NOT NULL)", [], |r|r.get(0)).map_err(error)?;
    if queued>=32 { return Err("助理队列已满，请先处理已有工作。".into()); }
    let at=now_ms();
    let id=format!("run-{:x}-{:x}-{:x}",at,std::process::id(),super::NEXT_ID.fetch_add(1,std::sync::atomic::Ordering::Relaxed));
    tx.execute("INSERT INTO assistant_runs(id,idempotency_key,task_id,title,instruction,agent_id,agent_name,status,created_at,updated_at,parent_run_id,request_fingerprint,protocol,route_json,session_id) VALUES(?1,?2,?3,?4,?5,?6,?7,'queued',?8,?8,?9,?10,?11,?12,?13)", params![id,request.idempotency_key,request.task_id,request.title,request.instruction,request.profile.id,request.profile.name,at,request.parent_run_id,fingerprint,request.profile.protocol,serde_json::to_string(&request.profile).map_err(error)?,request.profile.session_id]).map_err(error)?;
    let run=get(&tx,&id)?;
    tx.commit().map_err(error)?;
    Ok((run,true))
}

pub(super) fn mark_running(c:&Connection,id:&str)->Result<bool,String> {
    c.execute("UPDATE assistant_runs SET status='running',updated_at=?2 WHERE id=?1 AND status='queued'",params![id,now_ms()]).map(|n|n==1).map_err(error)
}

/// Late HTTP responses cannot overwrite cancellation or restart recovery.
pub(super) fn finish(c:&Connection,id:&str,result:Result<String,String>)->Result<bool,String> {
    let (status,text,error_message)=match result {
        Ok(text) if !text.trim().is_empty()=>("review",text,String::new()),
        Ok(_)=>("failed",String::new(),"助理未返回可用内容，请重试或调整任务。".into()),
        Err(e)=>("failed",String::new(),e),
    };
    c.execute("UPDATE assistant_runs SET status=?2,result=?3,error=?4,updated_at=?5 WHERE id=?1 AND (status='running' OR (?2='failed' AND status='queued'))",params![id,status,text,error_message,now_ms()]).map(|n|n==1).map_err(error)
}

pub(super) fn cancel(c:&Connection,id:&str)->Result<AgentRun,String> {
    c.execute("UPDATE assistant_runs SET status='cancelled',error=CASE WHEN external_run_id IS NOT NULL THEN '已停止跟进；远端助理可能仍在执行，请在原会话确认。' ELSE '' END,updated_at=?2 WHERE id=?1 AND (status IN('queued','running') OR (status='interrupted' AND external_run_id IS NOT NULL))",params![id,now_ms()]).map_err(error)?;
    get(c,id)
}

/// An atomic cancellation before any external handle exists wins against prepare_dispatch.
pub(super) fn cancel_before_dispatch(c: &Connection, id: &str) -> Result<Option<AgentRun>, String> {
    let changed = c.execute("UPDATE assistant_runs SET status='cancelled',error='',updated_at=?2
      WHERE id=?1 AND protocol IN('grok-webhook','dots-mcp','grok-direct','dots-direct','muse-code','deepseek-harness','muse-personal','notion-web') AND external_run_id IS NULL
      AND status IN('queued','running','interrupted')",params![id,now_ms()]).map_err(error)?;
    if changed == 1 { get(c,id).map(Some) } else { Ok(None) }
}

/// Worker cancellation only stops local monitoring. A native external handle needs bridge acknowledgement.
pub(super) fn worker_stopped(c: &Connection, id: &str) -> Result<AgentRun, String> {
    let run = get(c,id)?;
    if super::is_native_protocol(&run.protocol) && run.external_run_id.is_some() {
        if matches!(run.status.as_str(),"queued"|"running") {
            interrupt(c,id,"本地跟进已暂停，停止跟进尚未确认。恢复连接后可重试；远端助理可能仍在执行。")?;
        }
        return get(c,id);
    }
    cancel(c,id)
}

/// A successful HTTP response alone is insufficient: retain real final results or confirm the closed record.
pub(super) fn confirm_bridge_close(c: &Connection, id: &str, snapshot: &Snapshot) -> Result<AgentRun, String> {
    let run = get(c,id)?;
    if run.external_run_id.as_deref() != Some(snapshot.id.as_str()) {
        if matches!(run.status.as_str(),"review"|"failed"|"cancelled") { return Ok(run); }
        return Err("桥接返回了不匹配的关闭记录。".into());
    }
    if !snapshot.is_terminal() { return Err("桥接服务尚未确认关闭执行记录，请稍后重试停止跟进。".into()); }
    if run.status == "cancelled" && matches!(snapshot.status.as_str(),"review"|"failed") {
        // Repair a legacy local-only cancel only after this explicit, same-handle close request.
        // Ordinary polling still cannot overwrite cancelled work.
        if snapshot.status == "review" && snapshot.result.trim().is_empty() { return Err("助理尚未交回可复核结果。".into()); }
        let result = if snapshot.status == "review" { snapshot.result.as_str() } else { "" };
        let message = if snapshot.status == "failed" && snapshot.error.is_empty() { "助理报告本次执行失败，请检查原会话。" } else { snapshot.error.as_str() };
        c.execute("UPDATE assistant_runs SET status=?2,progress=?3,result=?4,error=?5,delivery_status=?6,remote_updated_at=?7,updated_at=?8,
          session_id=COALESCE(?10,session_id),turn_id=COALESCE(?11,turn_id),event_cursor=COALESCE(?12,event_cursor),attention_json=?13,messages_json=?14,remote_stopped=COALESCE(?15,remote_stopped)
          WHERE id=?1 AND status='cancelled' AND external_run_id=?9 AND remote_updated_at<=?7",
          params![id,snapshot.status,snapshot.progress,result,message,snapshot.delivery_status,snapshot.updated_at,now_ms(),snapshot.id,
              snapshot.session_id,snapshot.turn_id,snapshot.cursor,snapshot.attention.as_ref().map(serde_json::to_string).transpose().map_err(error)?,
              serde_json::to_string(&snapshot.messages).map_err(error)?,snapshot.remote_stopped]).map_err(error)?;
    } else { apply_remote(c,id,snapshot)?; }
    // Keep run.id for traceability. Clearing this handle records acknowledgement and distinguishes legacy unconfirmed cancels.
    if snapshot.status == "cancelled" {
        c.execute("UPDATE assistant_runs SET external_run_id=NULL,updated_at=?2
          WHERE id=?1 AND status='cancelled' AND external_run_id=?3",params![id,now_ms(),snapshot.id]).map_err(error)?;
    }
    get(c,id)
}

pub(super) fn review(c:&Connection,id:&str,decision:&str)->Result<AgentRun,String> {
    if decision!="accepted" && decision!="rejected" { return Err("复核操作无效。".into()); }
    c.execute("UPDATE assistant_runs SET review_decision=?2,reviewed_at=?3,updated_at=?3 WHERE id=?1 AND status='review' AND review_decision IS NULL",params![id,decision,now_ms()]).map_err(error)?;
    let run=get(c,id)?;
    if run.status!="review" { return Err("这次执行尚未交回可复核的结果。".into()); }
    if run.review_decision.as_deref()!=Some(decision) { return Err("这份结果已经复核，请通过新的执行继续处理。".into()); }
    Ok(run)
}

pub(super) fn recover(c:&Connection)->Result<usize,String> {
    init(c)?;
    c.execute("UPDATE assistant_runs SET status='interrupted',error=CASE WHEN external_run_id IS NOT NULL AND protocol IN('grok-direct','dots-direct','muse-code','deepseek-harness','muse-personal','notion-web') THEN '应用已重新启动。可以同步读取原会话；不会自动重发任务。' WHEN external_run_id IS NOT NULL THEN '应用已重新启动。重新填写桥接密钥后可同步原执行；不会自动重发任务。' ELSE '应用已重新启动，未确认此前请求的最终结果。请检查已有交付后再重试。' END,updated_at=?1 WHERE status IN('queued','running')",[now_ms()]).map_err(error)
}


pub(super) fn route(c: &Connection, id: &str) -> Result<AgentProfile, String> {
    let raw: String = c.query_row("SELECT route_json FROM assistant_runs WHERE id=?1", [id], |r| r.get(0)).map_err(error)?;
    serde_json::from_str(&raw).map_err(|_| "这次执行没有可用的原生连接记录。".into())
}

/// Record the external identifier BEFORE network I/O, allowing GET after a lost POST response.
pub(super) fn prepare_dispatch(c: &Connection, id: &str) -> Result<bool, String> {
    c.execute("UPDATE assistant_runs SET external_run_id=id,delivery_status='pending',updated_at=?2
      WHERE id=?1 AND status='running' AND protocol IN('grok-webhook','dots-mcp','grok-direct','dots-direct','muse-code','deepseek-harness','muse-personal','notion-web') AND external_run_id IS NULL",
      params![id, now_ms()]).map(|n| n == 1).map_err(error)
}

/// Only a definitive pre-acceptance rejection can release a native run without reconciliation.
pub(super) fn reject_dispatch(c: &Connection, id: &str, message: &str) -> Result<bool, String> {
    c.execute("UPDATE assistant_runs SET status='failed',delivery_status='rejected',error=?2,external_run_id=NULL,updated_at=?3
      WHERE id=?1 AND status='running' AND remote_updated_at=0",
      params![id,message,now_ms()]).map(|n| n == 1).map_err(error)
}

pub(super) fn interrupt(c: &Connection, id: &str, message: &str) -> Result<bool, String> {
    c.execute("UPDATE assistant_runs SET status='interrupted',error=?2,delivery_status=CASE WHEN external_run_id IS NOT NULL AND remote_updated_at=0 THEN 'unknown' ELSE delivery_status END,updated_at=?3 WHERE id=?1 AND status IN('running','queued','interrupted')",
        params![id, message, now_ms()]).map(|n| n == 1).map_err(error)
}

/// Only this matching external run may update a live record. Stale replies and cancelled work cannot win.
pub(super) fn apply_remote(c: &Connection, id: &str, snapshot: &Snapshot) -> Result<bool, String> {
    let current = get(c, id)?;
    if current.external_run_id.as_deref() != Some(snapshot.id.as_str()) ||
        !matches!(current.status.as_str(), "running" | "interrupted") { return Ok(false); }
    let prior: i64 = c.query_row("SELECT remote_updated_at FROM assistant_runs WHERE id=?1", [id], |r| r.get(0)).map_err(error)?;
    if snapshot.updated_at < prior { return Ok(false); }
    let status = if snapshot.status == "queued" { "running" } else { &snapshot.status };
    if status == "review" && snapshot.result.trim().is_empty() { return Err("助理尚未交回可复核结果。".into()); }
    let result = if status == "review" { snapshot.result.as_str() } else { "" };
    let error_message = match status {
        "cancelled" if snapshot.remote_stopped == Some(true) => "",
        "cancelled" if snapshot.remote_stopped == Some(false) => "已停止本地等待；远端助理可能仍在执行。",
        "cancelled" => "桥接记录已停止跟进；不代表远端助理已停止执行。",
        "failed" if snapshot.error.is_empty() => "助理报告本次执行失败，请检查原会话。",
        _ => snapshot.error.as_str(),
    };
    if snapshot.updated_at == prior && current.status == status && current.progress == snapshot.progress &&
        current.result == result && current.error == error_message && current.delivery_status == snapshot.delivery_status &&
        current.session_id.as_ref() == snapshot.session_id.as_ref().or(current.session_id.as_ref()) &&
        current.turn_id.as_ref() == snapshot.turn_id.as_ref().or(current.turn_id.as_ref()) &&
        current.cursor.as_ref() == snapshot.cursor.as_ref().or(current.cursor.as_ref()) &&
        current.attention == snapshot.attention && current.messages == snapshot.messages &&
        current.remote_stopped == snapshot.remote_stopped.or(current.remote_stopped) { return Ok(false); }
    c.execute("UPDATE assistant_runs SET status=?2,progress=?3,result=?4,error=?5,delivery_status=?6,remote_updated_at=?7,updated_at=?8,
      session_id=COALESCE(?9,session_id),turn_id=COALESCE(?10,turn_id),event_cursor=COALESCE(?11,event_cursor),attention_json=?12,messages_json=?13,remote_stopped=COALESCE(?14,remote_stopped)
      WHERE id=?1 AND status IN('running','interrupted') AND remote_updated_at<=?7",
      params![id,status,snapshot.progress,result,error_message,snapshot.delivery_status,snapshot.updated_at,now_ms(),
          snapshot.session_id,snapshot.turn_id,snapshot.cursor,snapshot.attention.as_ref().map(serde_json::to_string).transpose().map_err(error)?,
          serde_json::to_string(&snapshot.messages).map_err(error)?,snapshot.remote_stopped]).map(|n| n == 1).map_err(error)
}

#[cfg(test)]
#[path = "store_native_tests.rs"]
mod native_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_jobs::AgentProfile;
    fn request(key:&str,task:&str)->StartRunRequest {
        StartRunRequest{idempotency_key:key.into(),task_id:task.into(),title:"研究安排".into(),instruction:"整理给定资料".into(),profile:AgentProfile{id:"a".into(),name:"助理 A".into(),endpoint:"http://127.0.0.1:3000/v1/chat/completions".into(),model:"test".into(),protocol:"openai".into(),agent_ref:String::new(),webhook_url:String::new(),session_id:None},context:None,parent_run_id:None}
    }
    #[test]
    fn duplicate_retry_is_same_execution_and_different_payload_is_rejected() {
        let mut c=Connection::open_in_memory().unwrap();
        let req=request("once","t1");
        let (first,created)=enqueue(&mut c,&req).unwrap(); assert!(created);
        let (second,created)=enqueue(&mut c,&req).unwrap(); assert!(!created); assert_eq!(first.id,second.id);
        assert!(enqueue(&mut c,&request("once","t2")).is_err());
        assert_eq!(list(&c).unwrap().len(),1);
    }
    #[test]
    fn one_task_has_one_active_owner_but_other_tasks_can_queue() {
        let mut c=Connection::open_in_memory().unwrap();
        let (run,_)=enqueue(&mut c,&request("k1","t1")).unwrap();
        let mut duplicate=request("k2","t1"); duplicate.profile.id="another".into();
        assert!(enqueue(&mut c,&duplicate).is_err());
        assert!(enqueue(&mut c,&request("k3","t2")).is_ok());
        cancel(&c,&run.id).unwrap();
        assert!(enqueue(&mut c,&duplicate).is_ok());
    }
    #[test]
    fn cancellation_wins_over_late_success_and_is_idempotent() {
        let mut c=Connection::open_in_memory().unwrap();
        let (run,_)=enqueue(&mut c,&request("k1","t1")).unwrap();
        assert!(mark_running(&c,&run.id).unwrap());
        cancel(&c,&run.id).unwrap();
        assert!(!finish(&c,&run.id,Ok("迟到结果".into())).unwrap());
        assert_eq!(cancel(&c,&run.id).unwrap().status,"cancelled");
        assert!(get(&c,&run.id).unwrap().result.is_empty());
    }
    #[test]
    fn result_is_saved_for_review_and_handoff_stays_on_same_task() {
        let mut c=Connection::open_in_memory().unwrap();
        let (run,_)=enqueue(&mut c,&request("k1","t1")).unwrap();
        mark_running(&c,&run.id).unwrap(); finish(&c,&run.id,Ok("资料与结论".into())).unwrap();
        let accepted=review(&c,&run.id,"accepted").unwrap();
        assert_eq!(accepted.status,"review"); assert_eq!(accepted.result,"资料与结论");
        assert!(accepted.reviewed_at.is_some());
        assert_eq!(review(&c,&run.id,"accepted").unwrap().reviewed_at,accepted.reviewed_at);
        let mut next=request("k2","t1"); next.parent_run_id=Some(run.id.clone());
        assert!(enqueue(&mut c,&next).is_ok());
        let mut wrong=request("k3","other"); wrong.parent_run_id=Some(run.id);
        assert!(enqueue(&mut c,&wrong).is_err());
    }
    #[test]
    fn restart_marks_only_unfinished_work_interrupted() {
        let mut c=Connection::open_in_memory().unwrap();
        let (a,_)=enqueue(&mut c,&request("a","t1")).unwrap();
        let (b,_)=enqueue(&mut c,&request("b","t2")).unwrap();
        mark_running(&c,&a.id).unwrap(); finish(&c,&a.id,Ok("已保存".into())).unwrap();
        assert_eq!(recover(&c).unwrap(),1);
        assert_eq!(get(&c,&a.id).unwrap().result,"已保存");
        assert_eq!(get(&c,&b.id).unwrap().status,"interrupted");
        assert!(!mark_running(&c,&b.id).unwrap());
    }
    #[test]
    fn storage_survives_reopen_with_result_and_review_history() {
        let path=std::env::temp_dir().join(format!("antdesk-runs-{}-{}.sqlite",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let id;
        { let mut c=Connection::open(&path).unwrap(); let (run,_)=enqueue(&mut c,&request("a","t1")).unwrap(); id=run.id;
          mark_running(&c,&id).unwrap(); finish(&c,&id,Ok("持久交付".into())).unwrap(); review(&c,&id,"rejected").unwrap(); }
        let c=Connection::open(&path).unwrap();
        assert_eq!(get(&c,&id).unwrap().result,"持久交付");
        assert_eq!(get(&c,&id).unwrap().review_decision.as_deref(),Some("rejected"));
        drop(c);std::fs::remove_file(path).unwrap();
    }
}
