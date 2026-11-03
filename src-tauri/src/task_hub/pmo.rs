//! Assistant priority proposals are persisted for the user's decision.
use super::HubSnapshot;
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};

pub(super) fn enabled(snapshot: &HubSnapshot) -> bool {
    snapshot.payload["pmo"]["enabled"] == true
}

pub(super) fn context(snapshot: &HubSnapshot) -> Value {
    if !enabled(snapshot) { return Value::Null; }
    let pmo = &snapshot.payload["pmo"];
    json!({"enabled":true,"approvalRequired":true,
        "weeklyCapacityMinutes":pmo["weeklyCapacityMinutes"],"focusLimit":pmo["focusLimit"],
        "projects":pmo["projects"].as_array().into_iter().flatten().take(100).map(|p| {
            let mut result = serde_json::Map::new();
            for key in ["id","name","role","priority","weeklyBudgetMinutes","goal","definitionOfDone","scopeFrozen","stage","scores","decisionReason"] {
                if let Some(value)=p.get(key) { result.insert(key.to_owned(),value.clone()); }
            }
            Value::Object(result)
        }).collect::<Vec<_>>()})
}

/// Whitelist planning fields; never serialize a whole frontend cache object.
pub(super) fn task_context(snapshot: &HubSnapshot, cached: &Value) -> Value {
    let id = cached["id"].as_str().unwrap_or_default();
    let local = snapshot.payload["localTasks"].as_array().into_iter().flatten()
        .find(|task| task["id"].as_str()==Some(id));
    let patch = snapshot.payload["overrides"].get(id);
    let mut result = serde_json::Map::new();
    for key in ["projectId","projectName","state","stage","priority","pmoPriority","scope","verification",
        "estimateMinutes","spentMinutes","owner","acceptanceCriteria","evidence","description",
        "dependencies","sourceRefs","blockedReason","scores"] {
        let value = patch.and_then(|p|p.get(key)).or_else(||local.and_then(|p|p.get(key))).or_else(||cached.get(key));
        if let Some(value)=value { result.insert(key.to_owned(),value.clone()); }
    }
    Value::Object(result)
}

pub(super) struct Proposal {
    pub payload: Value,
    pub id: String,
    pub created: bool,
}

pub(super) fn propose(snapshot: &HubSnapshot, tasks: &[Value], order: &[String], rationale: &str) -> Result<Proposal, String> {
    let base: Vec<String> = tasks.iter().filter_map(|t|t["id"].as_str().map(str::to_owned)).collect();
    let records = snapshot.payload["pmo"]["reviewRecords"].as_array().cloned().unwrap_or_default();
    for record in &records {
        if record["kind"]=="priority" && record["status"]=="pending"
            && record["baseOrder"]==json!(base) && record["proposedOrder"]==json!(order) {
            if let Some(id)=record["id"].as_str() { return Ok(Proposal {payload:snapshot.payload.clone(),id:id.to_owned(),created:false}); }
        }
    }
    if records.iter().filter(|r|r["status"]=="pending").count()>=200 {
        return Err("已有 200 条未决评审，请先在 AntDesk 处理已有建议。".into());
    }
    let at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(i64::MAX as u128) as i64;
    let id = format!("review-priority-{at:x}-{:x}",snapshot.revision+1);
    let text = if rationale.trim().is_empty() { "助理提交了一份优先顺序建议，请核对理由与项目约束后决定是否采纳。".to_owned() }
        else { rationale.trim().chars().take(4000).collect() };
    let mut next = records;
    while next.len()>=200 {
        if let Some(index)=next.iter().position(|r|r["status"]!="pending") { next.remove(index); } else { break; }
    }
    next.push(json!({"id":id,"kind":"priority","text":text,"source":"助理 MCP","createdAt":at,
        "baseRevision":snapshot.revision,"baseOrder":base,"proposedOrder":order,"status":"pending","outcome":"note"}));
    let mut payload=snapshot.payload.clone();
    payload["pmo"]["reviewRecords"]=Value::Array(next);
    Ok(Proposal {payload,id,created:true})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn initial() -> HubSnapshot { HubSnapshot {revision:4,payload:json!({"order":["local:a","local:b"],
        "localTasks":[{"id":"local:a","title":"验收","state":"ready"}],"pmo":{"enabled":true,"reviewRecords":[]}})} }
    fn tasks()->Vec<Value>{vec![json!({"id":"local:a","title":"A"}),json!({"id":"local:b","title":"B"})]}
    #[test]
    fn proposal_preserves_order_and_task_state_until_human_decision(){
        let before=initial();let proposed=propose(&before,&tasks(),&["local:b".into(),"local:a".into()],"先解除阻塞").unwrap();
        assert!(proposed.created);assert_eq!(proposed.payload["order"],before.payload["order"]);
        assert_eq!(proposed.payload["localTasks"],before.payload["localTasks"]);
        let record=&proposed.payload["pmo"]["reviewRecords"][0];
        assert_eq!(record["status"],"pending");assert_eq!(record["baseOrder"],json!(["local:a","local:b"]));
    }
    #[test]
    fn duplicate_pending_proposal_is_not_appended(){
        let one=propose(&initial(),&tasks(),&["local:b".into(),"local:a".into()],"理由").unwrap();
        let snapshot=HubSnapshot{revision:5,payload:one.payload};
        let two=propose(&snapshot,&tasks(),&["local:b".into(),"local:a".into()],"重试").unwrap();
        assert!(!two.created);assert_eq!(two.id,one.id);assert_eq!(two.payload["pmo"]["reviewRecords"].as_array().unwrap().len(),1);
    }
    #[test]
    fn proposal_cap_never_drops_pending_decisions(){
        let mut before=initial();before.payload["pmo"]["reviewRecords"]=json!((0..200).map(|n|json!({"id":n,"status":"pending"})).collect::<Vec<_>>());
        assert!(propose(&before,&tasks(),&["local:b".into(),"local:a".into()],"理由").is_err());
    }
    #[test]
    fn context_does_not_copy_arbitrary_cache_fields(){
        let context=task_context(&initial(),&json!({"id":"local:a","apiKey":"secret","privateMessages":"secret","acceptanceCriteria":"真机录像"}));
        assert!(context.get("apiKey").is_none());assert!(context.get("privateMessages").is_none());
        assert_eq!(context["state"],"ready");assert_eq!(context["acceptanceCriteria"],"真机录像");
    }
}
