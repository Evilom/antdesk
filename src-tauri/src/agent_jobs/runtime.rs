//! Cancellable run orchestration; external work survives desktop polling interruptions.
use super::{bridge, cancellable, signal_change, store, transport, AgentJobsState, AgentProfile, AgentRun, StartRunRequest};
use std::{sync::Arc, time::Duration};
use tauri::Manager;
use tokio::sync::{watch, Semaphore};

pub(super) fn agent_slot(state: &AgentJobsState, id: &str) -> Result<Arc<Semaphore>, String> {
    let mut slots = state.per_agent.lock().map_err(|_| "助理执行器暂时不可用。")?;
    if !slots.contains_key(id) && slots.len() >= 64 { return Err("本次运行的助理配置数量已达上限，请重启后再添加。".into()); }
    Ok(slots.entry(id.to_string()).or_insert_with(|| Arc::new(Semaphore::new(1))).clone())
}
fn control(app: &tauri::AppHandle, id: &str) -> Result<Option<watch::Receiver<bool>>, String> {
    let state = app.state::<AgentJobsState>();
    let mut controls = state.controls.lock().map_err(|_| "助理执行器暂时不可用。")?;
    if controls.contains_key(id) { return Ok(None); }
    let (tx, rx) = watch::channel(false);
    controls.insert(id.to_string(), tx);
    Ok(Some(rx))
}
enum Outcome { Result(Result<String, String>), Synced, Uncertain(String) }

fn apply(app: &tauri::AppHandle, id: &str, snapshot: &bridge::Snapshot) -> Result<(), String> {
    let changed = store::apply_remote(&super::super::pm::open(app)?, id, snapshot)?;
    if changed { signal_change(app, id); }
    Ok(())
}
async fn poll(app: &tauri::AppHandle, id: &str, client: &bridge::Client) -> Outcome {
    // A long job may keep running remotely. Polling stops after six hours, retaining the handle for manual resync.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(6 * 60 * 60);
    let mut failures = 0u32;
    loop {
        match client.get(id).await {
            Ok(snapshot) => {
                failures = 0;
                if let Err(message) = apply(app, id, &snapshot) { return Outcome::Uncertain(message); }
                if snapshot.is_terminal() { return Outcome::Synced; }
            }
            Err(message) => {
                failures += 1;
                if failures >= 3 { return Outcome::Uncertain(message); }
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Outcome::Uncertain("本次进度跟进已暂停，远端工作可能仍在继续。可以同步原执行获取后续结果。".into());
        }
        tokio::time::sleep(Duration::from_secs(if failures == 0 { 2 } else { 2u64.pow(failures + 1) })).await;
    }
}
async fn initial(app: &tauri::AppHandle, id: &str, request: &StartRunRequest, primary: Option<&str>, bridge_key: Option<&str>, slot: Arc<Semaphore>, global: Arc<Semaphore>) -> Outcome {
    let _agent = match slot.acquire_owned().await { Ok(v) => v, Err(_) => return Outcome::Result(Err("助理队列已关闭。".into())) };
    let _global = match global.acquire_owned().await { Ok(v) => v, Err(_) => return Outcome::Result(Err("助理执行器已关闭。".into())) };
    let running = super::super::pm::open(app).and_then(|c| store::mark_running(&c, id));
    match running {
        Ok(true) => signal_change(app, id),
        Ok(false) => return Outcome::Synced,
        Err(e) => return Outcome::Uncertain(e),
    }
    if !request.profile.is_native() { return Outcome::Result(transport::execute(request, primary).await); }
    let client = match bridge::Client::new(&request.profile, bridge_key) { Ok(v) => v, Err(e) => return Outcome::Result(Err(e)) };
    match super::super::pm::open(app).and_then(|c| store::prepare_dispatch(&c, id)) {
        Ok(true) => signal_change(app, id),
        Ok(false) => return Outcome::Synced,
        Err(e) => return Outcome::Uncertain(e),
    }
    match client.submit(id, request, primary).await {
        Ok(snapshot) => {
            if let Err(e) = apply(app, id, &snapshot) { return Outcome::Uncertain(e); }
            if snapshot.is_terminal() { return Outcome::Synced; }
        }
        Err(e) if e.definitive => {
            match super::super::pm::open(app).and_then(|c| store::reject_dispatch(&c, id, &e.message)) {
                Ok(_) => { signal_change(app, id); return Outcome::Synced; }
                Err(storage_error) => return Outcome::Uncertain(storage_error),
            }
        }
        Err(e) => return Outcome::Uncertain(e.message),
    }
    poll(app, id, &client).await
}
fn persist_outcome(c: &rusqlite::Connection, id: &str, outcome: Option<Outcome>) -> Result<(), String> {
    match outcome {
        Some(Outcome::Result(value)) => store::finish(c,id,value).map(|_| ()),
        Some(Outcome::Synced) => Ok(()),
        Some(Outcome::Uncertain(message)) => store::interrupt(c,id,&message).map(|_| ()),
        None => store::worker_stopped(c,id).map(|_| ()),
    }
}

fn finish(app: &tauri::AppHandle, id: &str, outcome: Option<Outcome>) {
    if let Ok(c) = super::super::pm::open(app) {
        let stored = persist_outcome(&c, id, outcome);
        if stored.is_err() { eprintln!("AntDesk could not persist an assistant outcome; the external handle is preserved."); }
    }
    let state = app.state::<AgentJobsState>();
    if let Ok(mut controls) = state.controls.lock() { controls.remove(id); }
    signal_change(app, id);
}

pub(super) fn start(app: tauri::AppHandle, id: String, request: StartRunRequest, primary: Option<String>, bridge_key: Option<String>, slot: Arc<Semaphore>, global: Arc<Semaphore>) -> Result<(), String> {
    let receiver = match control(&app, &id) {
        Ok(Some(rx)) => rx,
        Ok(None) => return Ok(()),
        Err(e) => {
            if let Ok(c) = super::super::pm::open(&app) { let _ = store::cancel(&c, &id); }
            return Err(e);
        }
    };
    tauri::async_runtime::spawn(async move {
        let outcome = cancellable(initial(&app, &id, &request, primary.as_deref(), bridge_key.as_deref(), slot, global), receiver).await;
        finish(&app, &id, outcome);
    });
    Ok(())
}

pub(super) fn resume(app: tauri::AppHandle, run: AgentRun, profile: AgentProfile, key: String) -> Result<(), String> {
    let client = bridge::Client::new(&profile, Some(&key))?;
    let Some(receiver) = control(&app, &run.id)? else { return Ok(()); };
    tauri::async_runtime::spawn(async move {
        // This path only polls. It never calls submit, including after process recovery.
        let outcome = cancellable(poll(&app, &run.id, &client), receiver).await;
        finish(&app, &run.id, outcome);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_dropped_native_worker_does_not_claim_external_cancellation() {
        let mut c=rusqlite::Connection::open_in_memory().unwrap();
        let request=StartRunRequest{idempotency_key:"cancel-test".into(),task_id:"native-task".into(),title:"事项".into(),instruction:"处理".into(),
            profile:AgentProfile{id:"native".into(),name:"助理".into(),endpoint:"http://127.0.0.1:47631".into(),model:String::new(),protocol:"dots-mcp".into(),agent_ref:"omdot".into(),webhook_url:String::new(),session_id:None},
            context:None,parent_run_id:None};
        let (run,_)=store::enqueue(&mut c,&request).unwrap();
        store::mark_running(&c,&run.id).unwrap();store::prepare_dispatch(&c,&run.id).unwrap();
        persist_outcome(&c,&run.id,None).unwrap();
        let stopped=store::get(&c,&run.id).unwrap();
        assert_eq!(stopped.status,"interrupted");assert_eq!(stopped.external_run_id.as_deref(),Some(run.id.as_str()));
        let mut retry=request;retry.idempotency_key="no-duplicate".into();
        assert!(store::enqueue(&mut c,&retry).is_err());
    }
}
