use super::{model::*, store, ChatState};
use crate::{agent_jobs, assistant_runtime};
use std::time::Duration;
use tauri::{Emitter, Manager};

pub(super) fn changed(app:&tauri::AppHandle,room_id:&str){let _=app.emit("chat:changed",serde_json::json!({"roomId":room_id}));}
pub(super) fn changed_message(app:&tauri::AppHandle,message:&ChatMessage){let _=app.emit("chat:changed",serde_json::json!({"roomId":message.room_id,"message":message}));}
pub(super) async fn resolve(profiles:&[agent_jobs::AgentProfile])->Vec<ResolvedProfile>{
    let response=assistant_runtime::assistant_runtime_request(assistant_runtime::RuntimeRequest{method:"GET".into(),path:"/api/runtime/providers".into(),body:None}).await;
    profiles.iter().map(|profile|{
        let provider=response.as_ref().ok().and_then(|value|value["providers"].as_array()).and_then(|items|items.iter().find(|value|value["id"]==profile.protocol));
        let identity=provider.and_then(|v|v["connectionIdentity"].as_str()).filter(|s|s.len()<=256&&!s.is_empty()&&!s.chars().any(char::is_control)).unwrap_or("");
        let bound=binding(profile,identity);
        let ready=provider.is_some_and(|v|v["readiness"]=="ready")&&!bound.is_empty();
        let message=if bound.is_empty()&&provider.is_some_and(|v|v["readiness"]=="ready"){
            "尚未确认当前登录账号的身份，请刷新或重新连接这位助理。".into()
        }else{provider.and_then(|v|v["message"].as_str()).map(|v|short(v,4000)).unwrap_or_else(||"暂时无法读取助理连接状态，请恢复连接后重试。".into())};
        let concrete_agent_id=provider.and_then(|v|v["agentId"].as_str()).filter(|s|!s.is_empty()&&s.len()<=128&&s.bytes().all(|c|c.is_ascii_alphanumeric()||matches!(c,b'-'|b'_'|b'.'|b'~'))).map(str::to_owned);
        let concrete_session_id=provider.and_then(|v|v["sessionId"].as_str()).filter(|s|!s.is_empty()&&s.len()<=256&&!s.chars().any(char::is_control)).map(str::to_owned);
        ResolvedProfile{profile:profile.clone(),binding:bound,ready,message,concrete_agent_id,concrete_session_id}
    }).collect()
}
pub(super) fn kick(app:&tauri::AppHandle,room_id:&str)->Result<(),String>{
    let state=app.state::<ChatState>();
    let mut rooms=state.rooms.lock().map_err(|_|"聊天执行器暂时不可用。")?;
    if !rooms.insert(room_id.to_owned()){return Ok(());}
    let app=app.clone();let room_id=room_id.to_owned();
    tauri::async_runtime::spawn(async move{
        if let Err(_failure)=run_room(&app,&room_id).await{
            // Do not echo provider messages, message content or credentials to logs.
            eprintln!("AntDesk chat monitoring paused; persisted delivery state is retained.");
            if let Ok(mut rooms)=app.state::<ChatState>().rooms.lock(){rooms.remove(&room_id);}
            changed(&app,&room_id);
        }
    });Ok(())
}
async fn run_room(app:&tauri::AppHandle,room_id:&str)->Result<(),String>{
    loop{
        let next=store::next(&super::open(app)?,room_id)?;
        let Some(delivery)=next else{
            // Sender commits before acquiring this same lock; this closes the
            // empty-queue / worker-removal race without an automatic resend.
            let state=app.state::<ChatState>();let mut rooms=state.rooms.lock().map_err(|_|"聊天执行器暂时不可用。")?;
            if store::next(&super::open(app)?,room_id)?.is_none(){rooms.remove(room_id);return Ok(());}
            drop(rooms);continue;
        };
        if delivery.status=="queued"{execute(app,&delivery).await?;}else{observe(app,&delivery).await?;}
        if delivery.status=="interrupted"{tokio::time::sleep(Duration::from_secs(2)).await;}
        tokio::time::sleep(Duration::from_millis(650)).await;
    }
}
async fn execute(app:&tauri::AppHandle,queued:&Delivery)->Result<(),String>{
    let state=app.state::<ChatState>();let _operation=state.operations.lock().await;
    let current=store::delivery(&super::open(app)?,&queued.id)?;
    if current.status!="queued"{return Ok(());}
    let started=store::set_state(&mut super::open(app)?,&current.id,"running","")?;changed_message(app,&started);
    let resolved=resolve(std::slice::from_ref(&current.profile)).await;
    let Some(target)=resolved.first()else{return Err("无法读取聊天目标。".into());};
    if !target.ready || current.identity.is_empty() || current.identity!=target.binding{
        let issue=if current.identity.is_empty()||(!target.binding.is_empty()&&current.identity!=target.binding){"当前账号与发送时的助理身份不一致。请在当前会话重新发送，原消息没有转交给其他账号。"}else{&target.message};
        let failed=store::set_state(&mut super::open(app)?,&current.id,"failed",issue)?;changed_message(app,&failed);return Ok(());
    }
    let context=store::context(&super::open(app)?,&current)?;
    let mut profile=current.profile.clone();
    if profile.protocol=="notion-web" { profile.agent_ref="notion-web".into();profile.session_id=None; }
    if profile.protocol=="muse-personal"{
        let Some(agent_id)=&target.concrete_agent_id else{
            let failed=store::set_state(&mut super::open(app)?,&current.id,"failed","尚未确认原 Muse 账号编号，请重新检查连接。")?;
            changed_message(app,&failed);return Ok(());
        };
        profile.agent_ref=agent_id.clone();profile.session_id=None;
    }
    if profile.protocol=="dots-direct"&&target.concrete_agent_id.as_deref()==Some("omdot-events"){
        let Some(session_id)=&target.concrete_session_id else{
            let failed=store::set_state(&mut super::open(app)?,&current.id,"failed","原 Dot 的官方事件订阅尚未绑定，请完成连接后重试。")?;
            changed_message(app,&failed);return Ok(());
        };
        profile.agent_ref="omdot-events".into();profile.session_id=Some(session_id.clone());
    }
    let request=agent_jobs::StartRunRequest{idempotency_key:current.run_key.clone(),task_id:format!("chat:{}",current.id),
      title:format!("{} · {}",if current.room_id=="team"{"助理群"}else{"私聊"},short(&current.instruction,80)),
      instruction:format!("你是 AntDesk 中的 {}。请回应用户本次消息；群聊中只以你的身份发言。\n\n{}",current.profile.name,current.instruction),
      profile,context:Some(context),parent_run_id:None};
    // This marker precedes the existing job queue, which in turn persists its
    // request before any external send. An uncertain attempt is never replayed.
    store::attempted(&super::open(app)?,&current.id)?;
    match agent_jobs::assistant_start_run(app.clone(),app.state(),request).await{
        Ok(run)=>{store::attach(&mut super::open(app)?,&current.id,&run)?;}
        Err(issue)=>{
            if let Some(run)=agent_jobs::chat_run_by_key(app,&current.run_key)?{store::attach(&mut super::open(app)?,&current.id,&run)?;}
            else{store::set_state(&mut super::open(app)?,&current.id,"failed",&issue)?;}
        }
    }
    changed_message(app,&store::message(&super::open(app)?,&current.reply_message_id)?);Ok(())
}
async fn observe(app:&tauri::AppHandle,current:&Delivery)->Result<(),String>{
    let state=app.state::<ChatState>();let _operation=state.operations.lock().await;
    let current=store::delivery(&super::open(app)?,&current.id)?;
    if current.status!="running"&&current.status!="interrupted"{return Ok(());}
    let run=if let Some(id)=&current.run_id{Some(agent_jobs::chat_run(app,id)?)}else{agent_jobs::chat_run_by_key(app,&current.run_key)?};
    let Some(run)=run else{
        let interrupted=store::set_state(&mut super::open(app)?,&current.id,"interrupted","尚未确认原执行记录，未重发。请同步原消息。")?;
        changed_message(app,&interrupted);return Ok(());
    };
    let before=store::message(&super::open(app)?,&current.reply_message_id)?;
    let after=if current.run_id.is_some(){store::apply_run(&mut super::open(app)?,&current.id,&run)?}else{store::attach(&mut super::open(app)?,&current.id,&run)?};
    // Chat replies have no planner task to complete and are immediately visible.
    if run.status=="review"&&run.review_decision.is_none(){let _=agent_jobs::assistant_review_run(app.clone(),run.id.clone(),"accepted".into());}
    if before.updated_at!=after.updated_at||before.status!=after.status{changed_message(app,&after);}
    Ok(())
}

pub(super) async fn sync(app:&tauri::AppHandle,id:&str)->Result<ChatMessage,String>{
    let state=app.state::<ChatState>();let _operation=state.operations.lock().await;
    let d=store::delivery(&super::open(app)?,id)?;
    if ["completed","failed","cancelled"].contains(&d.status.as_str()){return store::message(&super::open(app)?,&d.reply_message_id);}
    let run=if let Some(run_id)=&d.run_id{Some(agent_jobs::chat_run(app,run_id)?)}else{agent_jobs::chat_run_by_key(app,&d.run_key)?};
    let result=if let Some(run)=run{
        if d.run_id.is_none(){store::attach(&mut super::open(app)?,id,&run)?;}
        match agent_jobs::assistant_sync_run(app.clone(),app.state(),run.id.clone()).await{
            Ok(value)=>store::apply_run(&mut super::open(app)?,id,&value)?,
            Err(issue)=>store::set_state(&mut super::open(app)?,id,"interrupted",&issue)?,
        }
    }else if !d.attempted{
        // Explicit user continuation of a never-submitted queue entry.
        store::set_state(&mut super::open(app)?,id,"queued","")?
    }else{
        store::set_state(&mut super::open(app)?,id,"failed","原发送没有建立执行记录。可明确重试；系统没有自动重发。")?
    };
    changed_message(app,&result);kick(app,&d.room_id)?;Ok(result)
}
pub(super) async fn cancel(app:&tauri::AppHandle,id:&str)->Result<ChatMessage,String>{
    let state=app.state::<ChatState>();let _operation=state.operations.lock().await;
    let d=store::delivery(&super::open(app)?,id)?;
    if ["completed","failed","cancelled"].contains(&d.status.as_str()){return store::message(&super::open(app)?,&d.reply_message_id);}
    let run=if let Some(run_id)=&d.run_id{Some(agent_jobs::chat_run(app,run_id)?)}else{agent_jobs::chat_run_by_key(app,&d.run_key)?};
    let result=if let Some(run)=run{
        if d.run_id.is_none(){store::attach(&mut super::open(app)?,id,&run)?;}
        match agent_jobs::assistant_cancel_run(app.clone(),app.state(),run.id).await{
            Ok(value)=>store::apply_run(&mut super::open(app)?,id,&value)?,
            Err(issue)=>store::set_state(&mut super::open(app)?,id,"interrupted",&issue)?,
        }
    }else{store::set_state(&mut super::open(app)?,id,"cancelled","")?};
    changed_message(app,&result);kick(app,&d.room_id)?;Ok(result)
}

