//! Durable shared conversations over the user's selected personal assistants.
//! Only explicit user messages create deliveries; replies never dispatch peers.
mod model;
mod store;
mod worker;

pub use model::{ChatHistory, ChatMessage, ChatRoom, SendRequest, SentMessage};
use model::*;
use crate::agent_jobs::AgentProfile;
use std::{collections::HashSet, sync::Mutex};
use tauri::Manager;

#[derive(Default)]
pub struct ChatState {
    rooms: Mutex<HashSet<String>>,
    // Serialize start/cancel/sync so a cancellation cannot race a not-yet-linked
    // existing job into claiming success before an actual send begins.
    operations: tokio::sync::Mutex<()>,
}
fn open(app:&tauri::AppHandle)->Result<rusqlite::Connection,String>{
    let connection=crate::pm::open(app)?;store::init(&connection)?;Ok(connection)
}
pub fn recover_interrupted(app:&tauri::AppHandle)->Result<(),String>{
    store::recover(&open(app)?)?;
    // A bridge recovery can finish after the transcript has already stored the
    // interruption. Apply that finished result before the window reads history.
    for (delivery_id, run_id) in store::interrupted_runs(&open(app)?)? {
        let Ok(run)=crate::agent_jobs::chat_run(app,&run_id) else { continue };
        if matches!(run.status.as_str(),"review"|"failed"|"cancelled") {
            store::apply_run(&mut open(app)?,&delivery_id,&run)?;
        }
    }
    for room in store::watching_rooms(&open(app)?)? { worker::kick(app,&room)?; }
    Ok(())
}

#[tauri::command]
pub async fn assistant_chat_list_rooms(app:tauri::AppHandle,profiles:Vec<AgentProfile>)->Result<Vec<ChatRoom>,String>{
    profiles_valid(&profiles)?;
    let resolved=worker::resolve(&profiles).await;
    store::ensure_rooms(&mut open(&app)?,&resolved)
}
#[tauri::command]
pub async fn assistant_chat_set_members(app:tauri::AppHandle,profiles:Vec<AgentProfile>,member_ids:Vec<String>)->Result<Vec<ChatRoom>,String>{
    profiles_valid(&profiles)?;
    let resolved=worker::resolve(&profiles).await;
    let result={let mut c=open(&app)?;store::ensure_rooms(&mut c,&resolved)?;store::set_members(&mut c,&resolved,&member_ids)?;store::ensure_rooms(&mut c,&resolved)?};
    worker::changed(&app,"team");Ok(result)
}
#[tauri::command]
pub fn assistant_chat_history(app:tauri::AppHandle,room_id:String,before:Option<i64>,limit:Option<usize>)->Result<ChatHistory,String>{
    field(&room_id,"聊天编号",512)?;
    if before.is_some_and(|value|value<=0){return Err("聊天分页编号无效。".into());}
    store::history(&open(&app)?,&room_id,before,limit.unwrap_or(100).clamp(1,200))
}
#[tauri::command]
pub async fn assistant_chat_send(app:tauri::AppHandle,request:SendRequest)->Result<SentMessage,String>{
    profiles_valid(&request.profiles)?;
    field(&request.room_id,"聊天编号",512)?;field(&request.client_message_id,"发送编号",128)?;
    field(&request.text,"消息",32_000)?;
    if request.mentions.len()>PROTOCOLS.len() || request.mentions.iter().collect::<HashSet<_>>().len()!=request.mentions.len(){return Err("@ 目标无效，请重新选择助理。".into());}
    let resolved=worker::resolve(&request.profiles).await;
    let sent={let mut c=open(&app)?;store::ensure_rooms(&mut c,&resolved)?;store::enqueue(&mut c,&request,&resolved)?};
    worker::changed(&app,&sent.room_id);worker::kick(&app,&sent.room_id)?;Ok(sent)
}
#[tauri::command]
pub async fn assistant_chat_retry(app:tauri::AppHandle,delivery_id:String)->Result<ChatMessage,String>{
    field(&delivery_id,"投递编号",128)?;
    let state=app.state::<ChatState>();let _operation=state.operations.lock().await;
    let d=store::delivery(&open(&app)?,&delivery_id)?;
    if d.status=="failed"{
        let resolved=worker::resolve(std::slice::from_ref(&d.profile)).await;
        let target=resolved.first().ok_or("无法确认这位助理的身份。")?;
        if !target.ready{let failed=store::set_state(&mut open(&app)?,&delivery_id,"failed",&target.message)?;worker::changed_message(&app,&failed);return Ok(failed);}
        if d.identity.is_empty()&&d.room_id=="team"{store::bind_retry(&mut open(&app)?,&delivery_id,&target.binding)?;}
        else if d.identity!=target.binding{return Err("当前账号与原接收者不同，请在当前助理会话重新发送。".into());}
        let room=store::room(&open(&app)?,&d.room_id)?;
        if room.archived{return Err("这是旧身份的私聊，请在当前助理私聊重新发送。".into());}
    }
    let result=store::retry(&mut open(&app)?,&delivery_id)?;
    worker::changed_message(&app,&result);worker::kick(&app,&d.room_id)?;Ok(result)
}
#[tauri::command]
pub async fn assistant_chat_cancel(app:tauri::AppHandle,delivery_id:String)->Result<ChatMessage,String>{
    field(&delivery_id,"投递编号",128)?;worker::cancel(&app,&delivery_id).await
}
#[tauri::command]
pub async fn assistant_chat_sync(app:tauri::AppHandle,delivery_id:String)->Result<ChatMessage,String>{
    field(&delivery_id,"投递编号",128)?;worker::sync(&app,&delivery_id).await
}
