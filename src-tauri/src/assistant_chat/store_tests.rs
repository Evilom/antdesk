use super::*;
use crate::agent_jobs::{AgentProfile, AgentRun};

fn profiles()->Vec<ResolvedProfile>{
    profiles_with_notion().into_iter().take(3).collect()
}
fn profiles_with_notion()->Vec<ResolvedProfile>{
    PROTOCOLS.iter().enumerate().map(|(i,protocol)|{
      let profile=AgentProfile{id:format!("member-{i}"),name:format!("助理{i}"),endpoint:"http://127.0.0.1:47631".into(),model:String::new(),
        protocol:(*protocol).into(),agent_ref:format!("original-{i}"),webhook_url:String::new(),session_id:None};
      let bound=binding(&profile,&format!("verified-account-{i}"));
      ResolvedProfile{profile,binding:bound,ready:true,message:String::new(),concrete_agent_id:Some(format!("account-{i}")),concrete_session_id:None}
    }).collect()
}
fn database(profiles:&[ResolvedProfile])->Connection{
    let mut c=Connection::open_in_memory().unwrap();init(&c).unwrap();ensure_rooms(&mut c,profiles).unwrap();c
}
fn request(profiles:&[ResolvedProfile],key:&str,room_id:&str,text:&str,mentions:&[usize])->SendRequest{
    SendRequest{room_id:room_id.into(),client_message_id:key.into(),text:text.into(),mentions:mentions.iter().map(|i|profiles[*i].profile.id.clone()).collect(),profiles:profiles.iter().map(|p|p.profile.clone()).collect()}
}
fn delivery_for(c:&Connection,message_id:&str,member_id:&str)->Delivery{
    let id:String=c.query_row("SELECT d.id FROM assistant_chat_deliveries d JOIN assistant_chat_messages m ON m.id=d.reply_message_id WHERE d.user_message_id=?1 AND m.author_id=?2",params![message_id,member_id],|r|r.get(0)).unwrap();delivery(c,&id).unwrap()
}
fn finish(c:&mut Connection,d:&Delivery,text:&str){
    let run=AgentRun{id:format!("run-{}",d.id),idempotency_key:d.run_key.clone(),task_id:format!("chat:{}",d.id),title:"test".into(),instruction:d.instruction.clone(),
      agent_id:d.profile.id.clone(),agent_name:d.profile.name.clone(),status:"review".into(),result:text.into(),error:String::new(),created_at:now(),updated_at:now(),
      parent_run_id:None,review_decision:None,reviewed_at:None,protocol:d.profile.protocol.clone(),progress:String::new(),delivery_status:"accepted".into(),
      external_run_id:Some(format!("run-{}",d.id)),session_id:None,turn_id:None,cursor:None,attention:None,messages:Vec::new(),remote_stopped:None};
    attach(c,&d.id,&run).unwrap();
}
fn member_ids(profiles:&[ResolvedProfile])->Vec<String>{
    profiles.iter().map(|p|p.profile.id.clone()).collect()
}
fn chat_counts(c:&Connection)->(i64,i64,i64){
    c.query_row("SELECT (SELECT count(*) FROM assistant_chat_messages),
      (SELECT count(*) FROM assistant_chat_deliveries),
      (SELECT count(*) FROM assistant_chat_sends)",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap()
}
fn stored_audiences(c:&Connection)->Vec<(String,String)>{
    let mut statement=c.prepare("SELECT id,audience_json FROM assistant_chat_messages WHERE room_id='team' ORDER BY seq").unwrap();
    let rows=statement.query_map([],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
    rows.collect::<Result<_,_>>().unwrap()
}

#[test]
fn one_group_three_identity_bound_private_rooms_and_read_only_archive(){
    let mut ps=profiles();let mut c=database(&ps);
    let rooms=ensure_rooms(&mut c,&ps).unwrap();assert_eq!(rooms.len(),4);assert_eq!(rooms[0].id,"team");
    let old=dm_id(&ps[0]);enqueue(&mut c,&request(&ps,"private-old",&old,"旧身份的私聊",&[]),&ps).unwrap();
    ps[0].binding=binding(&ps[0].profile,"different-account");
    let rooms=ensure_rooms(&mut c,&ps).unwrap();assert_eq!(rooms.iter().filter(|r|!r.archived).count(),4);
    assert!(rooms.iter().any(|r|r.id==old&&r.archived));
    assert!(enqueue(&mut c,&request(&ps,"wrong-person",&old,"不能换账号收到",&[]),&ps).is_err());
    assert!(history(&c,&old,None,100).unwrap().messages.iter().any(|m|m.text=="旧身份的私聊"));
}

#[test]
fn mention_targets_exactly_one_and_unknown_mentions_never_broadcast(){
    let ps=profiles();let mut c=database(&ps);
    let sent=enqueue(&mut c,&request(&ps,"mention-one","team","@Grok 处理这件事",&[1]),&ps).unwrap();
    let initial_history=history(&c,"team",None,100).unwrap();assert_eq!(initial_history.messages.len(),2);
    assert_eq!(initial_history.messages[1].author_id,ps[1].profile.id);
    assert_eq!(next(&c,"team").unwrap().unwrap().user_message_id,sent.message_id);
    let mut invalid=request(&ps,"bad-mention","team","不能误派",&[]);invalid.mentions=vec!["unknown".into()];
    assert!(enqueue(&mut c,&invalid,&ps).is_err());
    assert_eq!(initial_history.messages.len(),history(&c,"team",None,100).unwrap().messages.len());
}

#[test]
fn multiple_mentions_follow_the_selected_order(){
    let ps=profiles();let mut c=database(&ps);
    let sent=enqueue(&mut c,&request(&ps,"mention-order","team","Grok 先答，Muse 再看",&[1,0]),&ps).unwrap();
    let grok=delivery_for(&c,&sent.message_id,&ps[1].profile.id);
    assert_eq!(next(&c,"team").unwrap().unwrap().id,grok.id);
    finish(&mut c,&grok,"Grok 的先行回复");
    let muse=next(&c,"team").unwrap().unwrap();assert_eq!(muse.profile.id,ps[0].profile.id);
    assert!(context(&c,&muse).unwrap().contains("Grok 的先行回复"));
}

#[test]
fn duplicate_send_is_idempotent_and_changed_intent_is_rejected(){
    let ps=profiles();let mut c=database(&ps);let r=request(&ps,"same-send","team","讨论今天的事情",&[]);
    let a=enqueue(&mut c,&r,&ps).unwrap();let b=enqueue(&mut c,&r,&ps).unwrap();assert_eq!(a.message_id,b.message_id);
    assert_eq!(history(&c,"team",None,100).unwrap().messages.len(),4);
    let mut other=r.clone();other.text="另一件事情".into();assert!(enqueue(&mut c,&other,&ps).is_err());
    assert_eq!(c.query_row("SELECT count(*) FROM assistant_chat_deliveries",[],|r|r.get::<_,i64>(0)).unwrap(),3);
}

#[test]
fn later_group_speaker_receives_previous_reply_but_not_future_user_message(){
    let ps=profiles();let mut c=database(&ps);
    let first=enqueue(&mut c,&request(&ps,"turn-a","team","第一轮问题",&[]),&ps).unwrap();
    enqueue(&mut c,&request(&ps,"turn-b","team","尚未来到的第二轮问题",&[]),&ps).unwrap();
    let muse=delivery_for(&c,&first.message_id,&ps[0].profile.id);let grok=delivery_for(&c,&first.message_id,&ps[1].profile.id);
    assert_eq!(next(&c,"team").unwrap().unwrap().id,muse.id);
    finish(&mut c,&muse,"Muse 的真实第一轮回复");
    assert_eq!(next(&c,"team").unwrap().unwrap().id,grok.id);
    let context=context(&c,&grok).unwrap();assert!(context.contains("第一轮问题"));assert!(context.contains("Muse 的真实第一轮回复"));
    assert!(!context.contains("尚未来到的第二轮问题"));
    assert_eq!(c.query_row("SELECT count(*) FROM assistant_chat_deliveries",[],|r|r.get::<_,i64>(0)).unwrap(),6,"a reply must never spawn peer deliveries");
}

#[test]
fn private_history_never_flows_into_group_or_another_private_room(){
    let ps=profiles();let mut c=database(&ps);let muse_room=dm_id(&ps[0]);let grok_room=dm_id(&ps[1]);
    enqueue(&mut c,&request(&ps,"private-a",&muse_room,"Muse 私聊秘密",&[]),&ps).unwrap();
    let other=enqueue(&mut c,&request(&ps,"private-b",&grok_room,"Grok 私聊秘密",&[]),&ps).unwrap();
    let public=enqueue(&mut c,&request(&ps,"public","team","群里公开资料",&[]),&ps).unwrap();
    let group_context=context(&c,&delivery_for(&c,&public.message_id,&ps[1].profile.id)).unwrap();
    assert!(group_context.contains("群里公开资料"));assert!(!group_context.contains("Muse 私聊秘密"));assert!(!group_context.contains("Grok 私聊秘密"));
    let private_context=context(&c,&delivery_for(&c,&other.message_id,&ps[1].profile.id)).unwrap();
    assert!(private_context.contains("Grok 私聊秘密"));assert!(!private_context.contains("Muse 私聊秘密"));assert!(!private_context.contains("群里公开资料"));
}

#[test]
fn changing_member_account_does_not_share_prior_group_context(){
    let mut ps=profiles();let mut c=database(&ps);
    enqueue(&mut c,&request(&ps,"old-roster","team","旧账号可见的历史",&[]),&ps).unwrap();
    ps[0].binding=binding(&ps[0].profile,"replacement-user");ensure_rooms(&mut c,&ps).unwrap();
    let new=enqueue(&mut c,&request(&ps,"new-roster","team","新成员现在的消息",&[]),&ps).unwrap();
    let changed=context(&c,&delivery_for(&c,&new.message_id,&ps[0].profile.id)).unwrap();
    assert!(!changed.contains("旧账号可见的历史"));assert!(changed.contains("新成员现在的消息"));
    assert!(context(&c,&delivery_for(&c,&new.message_id,&ps[1].profile.id)).unwrap().contains("旧账号可见的历史"));
}

#[test]
fn unavailable_member_does_not_block_ready_peer_and_no_false_reply_is_created(){
    let mut ps=profiles();ps[0].ready=false;ps[0].message="需要登录".into();let mut c=database(&ps);
    let sent=enqueue(&mut c,&request(&ps,"offline-member","team","请大家讨论",&[]),&ps).unwrap();
    let muse=delivery_for(&c,&sent.message_id,&ps[0].profile.id);assert_eq!(muse.status,"failed");
    let bubble=message(&c,&muse.reply_message_id).unwrap();assert!(bubble.text.is_empty());assert_eq!(bubble.error,"需要登录");
    assert_eq!(next(&c,"team").unwrap().unwrap().profile.id,ps[1].profile.id);
}

#[test]
fn restart_preserves_intent_and_requires_explicit_continue_without_replaying(){
    let ps=profiles();let mut c=database(&ps);
    let sent=enqueue(&mut c,&request(&ps,"restart","team","不能重复投递",&[0]),&ps).unwrap();
    let d=delivery_for(&c,&sent.message_id,&ps[0].profile.id);
    set_state(&mut c,&d.id,"running","").unwrap();attempted(&c,&d.id).unwrap();recover(&c).unwrap();
    let saved=delivery(&c,&d.id).unwrap();assert_eq!(saved.status,"interrupted");assert!(saved.attempted);assert!(next(&c,"team").unwrap().is_none());
    assert!(retry(&mut c,&d.id).is_err());assert_eq!(history(&c,"team",None,100).unwrap().messages.len(),2);
}

#[test]
fn explicit_failed_retry_has_a_new_attempt_key_and_double_click_does_not_repeat(){
    let mut ps=profiles();ps[1].ready=false;let mut c=database(&ps);
    let sent=enqueue(&mut c,&request(&ps,"retry-failure","team","失败后再次处理",&[1]),&ps).unwrap();
    let d=delivery_for(&c,&sent.message_id,&ps[1].profile.id);
    retry(&mut c,&d.id).unwrap();let first=delivery(&c,&d.id).unwrap();assert_ne!(first.run_key,d.run_key);assert_eq!(first.attempt,1);
    retry(&mut c,&d.id).unwrap();assert_eq!(delivery(&c,&d.id).unwrap().run_key,first.run_key);
}

#[test]
fn explicit_bind_of_prelogin_group_retry_shares_only_that_turn(){
    let mut ps=profiles();ps[2].binding.clear();ps[2].ready=false;let mut c=database(&ps);
    enqueue(&mut c,&request(&ps,"unbound-old","team","更早的未授权历史",&[]),&ps).unwrap();
    let sent=enqueue(&mut c,&request(&ps,"unbound-current","team","用户明确重试的消息",&[2]),&ps).unwrap();
    let d=delivery_for(&c,&sent.message_id,&ps[2].profile.id);let fresh=binding(&ps[2].profile,"newly-verified-account");
    bind_retry(&mut c,&d.id,&fresh).unwrap();let rebound=delivery(&c,&d.id).unwrap();let context=context(&c,&rebound).unwrap();
    assert!(context.contains("用户明确重试的消息"));assert!(!context.contains("更早的未授权历史"));
}

#[test]
fn history_paginates_without_duplicates_and_context_budget_is_explicit(){
    let mut ps=profiles();for p in &mut ps{p.ready=false;}let mut c=database(&ps);
    for i in 0..60{enqueue(&mut c,&request(&ps,&format!("page-{i}"),"team",&format!("消息{i}"),&[1]),&ps).unwrap();}
    let recent=history(&c,"team",None,100).unwrap();assert_eq!(recent.messages.len(),100);assert!(recent.has_more);
    let older=history(&c,"team",recent.next_before,100).unwrap();assert_eq!(older.messages.len(),20);assert!(!older.has_more);
    assert!(older.messages.last().unwrap().seq<recent.messages.first().unwrap().seq);
    for i in 0..8{enqueue(&mut c,&request(&ps,&format!("large-{i}"),"team",&"上下文".repeat(3000),&[1]),&ps).unwrap();}
    let last: String=c.query_row("SELECT id FROM assistant_chat_deliveries ORDER BY rowid DESC LIMIT 1",[],|r|r.get(0)).unwrap();
    let context=context(&c,&delivery(&c,&last).unwrap()).unwrap();assert!(context.len()<100*1024);assert!(context.contains("较早记录超出"));
}

#[test]
fn an_interrupted_delivery_stays_watchable_until_its_run_finishes(){
    let ps=profiles();let mut c=database(&ps);
    enqueue(&mut c,&request(&ps,"watch","team","大家好",&[0]),&ps).unwrap();
    let first=next(&c,"team").unwrap().unwrap();
    let interrupted=AgentRun{id:"run-watch".into(),idempotency_key:first.run_key.clone(),task_id:format!("chat:{}",first.id),title:"test".into(),instruction:first.instruction.clone(),
      agent_id:first.profile.id.clone(),agent_name:first.profile.name.clone(),status:"interrupted".into(),result:String::new(),error:"原执行结果尚未确认".into(),created_at:now(),updated_at:now(),
      parent_run_id:None,review_decision:None,reviewed_at:None,protocol:first.profile.protocol.clone(),progress:"正在处理".into(),delivery_status:"accepted".into(),
      external_run_id:Some("run-watch".into()),session_id:None,turn_id:None,cursor:None,attention:None,messages:Vec::new(),remote_stopped:None};
    let paused=attach(&mut c,&first.id,&interrupted).unwrap();
    assert_eq!(paused.status,"interrupted");
    assert_eq!(next(&c,"team").unwrap().unwrap().id,first.id);
    let later=enqueue(&mut c,&request(&ps,"watch-next","team","下一条",&[0]),&ps).unwrap();
    assert_eq!(next(&c,"team").unwrap().unwrap().user_message_id,later.message_id);
    let recovered=AgentRun{status:"review".into(),result:"在的。".into(),error:String::new(),..interrupted};
    let shown=apply_run(&mut c,&first.id,&recovered).unwrap();
    assert_eq!(shown.status,"completed");assert_eq!(shown.text,"在的。");
    assert!(watching_rooms(&c).unwrap().contains(&"team".to_string()));
}

#[test]
fn adding_notion_profile_preserves_existing_group_members_and_history(){
    let old_profiles=profiles();
    let mut c=database(&old_profiles);
    let sent=enqueue(&mut c,&request(&old_profiles,"before-notion","team","已有的三助理群消息",&[0]),&old_profiles).unwrap();
    let reply=delivery_for(&c,&sent.message_id,&old_profiles[0].profile.id);
    finish(&mut c,&reply,"升级前已完成的真实回复");
    let original_history=encode(&history(&c,"team",None,100).unwrap().messages).unwrap();
    let original_audiences=stored_audiences(&c);
    let original_counts=chat_counts(&c);

    let ps=profiles_with_notion();
    assert_eq!(ps.len(),4);
    assert_eq!(ps[3].profile.protocol,"notion-web");
    for _ in 0..2 {
        let rooms=ensure_rooms(&mut c,&ps).unwrap();
        assert_eq!(rooms.iter().filter(|r|!r.archived).count(),5);
        assert_eq!(room(&c,"team").unwrap().member_ids,member_ids(&old_profiles));
        for p in &ps {
            assert!(rooms.iter().any(|r|r.id==dm_id(p)&&!r.archived));
        }
        assert_eq!(encode(&history(&c,"team",None,100).unwrap().messages).unwrap(),original_history);
        assert_eq!(stored_audiences(&c),original_audiences);
        assert_eq!(chat_counts(&c),original_counts);
    }
    assert!(enqueue(&mut c,&request(&ps,"not-joined","team","未加入的助理不能收到群任务",&[3]),&ps).is_err());
    assert_eq!(chat_counts(&c),original_counts);
    assert!(next(&c,"team").unwrap().is_none());
}

#[test]
fn explicitly_adding_notion_changes_membership_without_sending(){
    let ps=profiles_with_notion();
    let mut c=database(&ps);
    assert_eq!(room(&c,"team").unwrap().member_ids,member_ids(&ps[..3]));
    let original_counts=chat_counts(&c);

    set_members(&mut c,&ps,&member_ids(&ps)).unwrap();
    ensure_rooms(&mut c,&ps).unwrap();

    assert_eq!(room(&c,"team").unwrap().member_ids,member_ids(&ps));
    assert_eq!(chat_counts(&c),original_counts,"joining must not create messages, deliveries or send intents");
    assert!(history(&c,"team",None,100).unwrap().messages.is_empty());
    assert!(next(&c,"team").unwrap().is_none());
}

#[test]
fn a_new_member_sees_future_turns_without_rewriting_historical_audiences(){
    let old_profiles=profiles();
    let mut c=database(&old_profiles);
    let old=enqueue(&mut c,&request(&old_profiles,"old-private-roster","team","入群之前讨论的项目资料",&[1]),&old_profiles).unwrap();
    let old_reply=delivery_for(&c,&old.message_id,&old_profiles[1].profile.id);
    finish(&mut c,&old_reply,"入群之前的评审结论");
    let old_audiences=stored_audiences(&c);

    let ps=profiles_with_notion();
    ensure_rooms(&mut c,&ps).unwrap();
    set_members(&mut c,&ps,&member_ids(&ps)).unwrap();
    assert_eq!(stored_audiences(&c),old_audiences);

    let future=enqueue(&mut c,&request(&ps,"after-joining","team","入群之后的新任务",&[0,3]),&ps).unwrap();
    let peer=delivery_for(&c,&future.message_id,&ps[0].profile.id);
    let notion=delivery_for(&c,&future.message_id,&ps[3].profile.id);
    finish(&mut c,&peer,"入群之后同伴公开的评审");

    let new_member_context=context(&c,&notion).unwrap();
    assert!(new_member_context.contains("入群之后的新任务"));
    assert!(new_member_context.contains("入群之后同伴公开的评审"));
    assert!(!new_member_context.contains("入群之前讨论的项目资料"));
    assert!(!new_member_context.contains("入群之前的评审结论"));
    let existing_member_context=context(&c,&peer).unwrap();
    assert!(existing_member_context.contains("入群之前讨论的项目资料"));
    assert!(existing_member_context.contains("入群之前的评审结论"));

    let all_audiences=stored_audiences(&c);
    assert_eq!(&all_audiences[..old_audiences.len()],old_audiences.as_slice());
    for (_,audience) in &all_audiences[old_audiences.len()..] {
        let audience:Audience=serde_json::from_str(audience).unwrap();
        assert_eq!(audience.get(&ps[3].profile.id),Some(&ps[3].binding));
    }
    assert_eq!(chat_counts(&c),(5,3,2),"joining must not replay the older turn for the new member");
}

#[test]
fn invalid_member_lists_leave_the_current_roster_unchanged(){
    let ps=profiles_with_notion();
    let mut c=database(&ps);
    let original_members=room(&c,"team").unwrap().member_ids;
    let original_bindings:String=c.query_row("SELECT bindings_json FROM assistant_chat_rooms WHERE id='team'",[],|r|r.get(0)).unwrap();
    let invalid_lists=vec![
        Vec::new(),
        vec![ps[0].profile.id.clone(),ps[0].profile.id.clone()],
        vec![ps[0].profile.id.clone(),"unknown-member".into()],
    ];

    for members in invalid_lists {
        assert!(set_members(&mut c,&ps,&members).is_err(),"invalid members were accepted: {members:?}");
        assert_eq!(room(&c,"team").unwrap().member_ids,original_members);
        let bindings:String=c.query_row("SELECT bindings_json FROM assistant_chat_rooms WHERE id='team'",[],|r|r.get(0)).unwrap();
        assert_eq!(bindings,original_bindings);
        assert_eq!(chat_counts(&c),(0,0,0));
    }
}

#[test]
fn unresolved_group_deliveries_block_both_adding_and_removing_members(){
    let ps=profiles_with_notion();
    for status in ["queued","running","interrupted"] {
        let mut c=database(&ps);
        let sent=enqueue(&mut c,&request(&ps,"pending-roster","team","仍待处理的群任务",&[0]),&ps).unwrap();
        let pending=delivery_for(&c,&sent.message_id,&ps[0].profile.id);
        if status!="queued" {
            set_state(&mut c,&pending.id,status,"等待原结果").unwrap();
        }
        let original_members=room(&c,"team").unwrap().member_ids;
        let original_history=encode(&history(&c,"team",None,100).unwrap().messages).unwrap();
        let original_audiences=stored_audiences(&c);

        for members in [member_ids(&ps),member_ids(&ps[..2])] {
            assert!(set_members(&mut c,&ps,&members).is_err(),"membership changed with a {status} delivery");
            assert_eq!(room(&c,"team").unwrap().member_ids,original_members);
            assert_eq!(delivery(&c,&pending.id).unwrap().status,status);
            assert_eq!(encode(&history(&c,"team",None,100).unwrap().messages).unwrap(),original_history);
            assert_eq!(stored_audiences(&c),original_audiences);
            assert_eq!(chat_counts(&c),(2,1,1));
        }

        set_state(&mut c,&pending.id,"cancelled","用户已停止跟进").unwrap();
        set_members(&mut c,&ps,&member_ids(&ps)).unwrap();
        assert_eq!(room(&c,"team").unwrap().member_ids,member_ids(&ps));
        assert_eq!(stored_audiences(&c),original_audiences);
    }
}

#[test]
fn a_pending_private_delivery_does_not_block_group_membership_changes(){
    let ps=profiles_with_notion();
    let mut c=database(&ps);
    let private_room=dm_id(&ps[0]);
    let sent=enqueue(&mut c,&request(&ps,"private-pending",&private_room,"私聊仍在处理中",&[]),&ps).unwrap();

    set_members(&mut c,&ps,&member_ids(&ps)).unwrap();

    assert_eq!(room(&c,"team").unwrap().member_ids,member_ids(&ps));
    assert_eq!(next(&c,&private_room).unwrap().unwrap().user_message_id,sent.message_id);
    assert!(next(&c,"team").unwrap().is_none());
    assert_eq!(chat_counts(&c),(2,1,1));
}

#[test]
fn removed_members_stay_removed_after_the_database_is_reopened(){
    struct TestFile(std::path::PathBuf);
    impl Drop for TestFile {
        fn drop(&mut self){let _=std::fs::remove_file(&self.0);}
    }
    let unique=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let path=std::env::temp_dir().join(format!("antdesk-member-reopen-{}-{unique}.sqlite",std::process::id()));
    std::fs::File::options().write(true).create_new(true).open(&path).unwrap();
    let file=TestFile(path);
    let ps=profiles_with_notion();
    let mut c=Connection::open(&file.0).unwrap();
    init(&c).unwrap();
    ensure_rooms(&mut c,&ps).unwrap();
    set_members(&mut c,&ps,&member_ids(&ps)).unwrap();
    let sent=enqueue(&mut c,&request(&ps,"before-removal","team","移除之前四位成员共有的任务",&[3]),&ps).unwrap();
    let notion=delivery_for(&c,&sent.message_id,&ps[3].profile.id);
    finish(&mut c,&notion,"Notion 之前已交付的回复");
    let remaining=member_ids(&ps[..2]);
    set_members(&mut c,&ps,&remaining).unwrap();
    let original_history=encode(&history(&c,"team",None,100).unwrap().messages).unwrap();
    let original_audiences=stored_audiences(&c);
    drop(c);

    let mut reopened=Connection::open(&file.0).unwrap();
    init(&reopened).unwrap();
    let rooms=ensure_rooms(&mut reopened,&ps).unwrap();
    assert_eq!(room(&reopened,"team").unwrap().member_ids,remaining,"neither the legacy member nor Notion should be re-added on startup");
    assert_eq!(encode(&history(&reopened,"team",None,100).unwrap().messages).unwrap(),original_history);
    assert_eq!(stored_audiences(&reopened),original_audiences);
    assert_eq!(chat_counts(&reopened),(2,1,1));
    assert!(rooms.iter().any(|r|r.id==dm_id(&ps[3])&&!r.archived),"removing a group member must preserve its private room");

    let future=enqueue(&mut reopened,&request(&ps,"after-removal","team","移除后的新任务",&[]),&ps).unwrap();
    let mut statement=reopened.prepare("SELECT m.author_id FROM assistant_chat_deliveries d JOIN assistant_chat_messages m ON m.id=d.reply_message_id WHERE d.user_message_id=?1 ORDER BY d.ordinal").unwrap();
    let recipients:Vec<String>=statement.query_map([&future.message_id],|r|r.get(0)).unwrap().collect::<Result<_,_>>().unwrap();
    assert_eq!(recipients,remaining);
    assert_eq!(chat_counts(&reopened),(5,3,2));
    for (_,audience) in &stored_audiences(&reopened)[original_audiences.len()..] {
        let audience:Audience=serde_json::from_str(audience).unwrap();
        assert!(!audience.contains_key(&ps[2].profile.id));
        assert!(!audience.contains_key(&ps[3].profile.id));
    }
}
