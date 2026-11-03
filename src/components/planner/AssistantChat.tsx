import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { ArrowDown, AtSign, Check, Clock3, History, LoaderCircle, LockKeyhole, MessageCircle, RefreshCw, Send, Settings2, Square, Users, X } from 'lucide-react';
import type { ChatMessage, ChatRoom } from '../../lib/assistantChat';
import { insertChatMention, resolveChatMentions } from '../../lib/assistant-chat-mentions.mjs';
import type { useAgentWorkspace } from './useAgentWorkspace';
import type { useAssistantChat } from './useAssistantChat';
import Sheet from './Sheet';
import './assistant-chat.css';
import './notion-connection.css';

type Props = {
  chat: ReturnType<typeof useAssistantChat>; agents: ReturnType<typeof useAgentWorkspace>;
  onInteractionChange: (value: boolean) => void; onConnections: () => void;
};
const statusLabels = { queued: '等待回应', running: '正在处理', completed: '已回复', failed: '尚未完成', interrupted: '等待恢复', cancelled: '已停止跟进' };
const clock = (at: number) => new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const dayLabel = (at: number) => {
  const date = new Date(at), now = new Date();
  return date.toDateString() === now.toDateString() ? '今天' : date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
};
const avatar = (protocol?: string) => protocol === 'notion-web' ? 'N' : protocol === 'muse-personal' ? 'm' : protocol === 'grok-direct' ? 'G' : 'D';

export default function AssistantChat({ chat, agents, onInteractionChange, onConnections }: Props) {
  const [picker, setPicker] = useState(false);
  const [focused, setFocused] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [membersError, setMembersError] = useState('');
  const composer = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const room = chat.room;
  const group = room?.kind === 'group' || chat.roomId === 'team';
  const profiles = chat.profiles;
  const roomProfiles = profiles.filter(profile => room?.memberIds.includes(profile.id));
  const outsideProfiles = profiles.filter(profile => !room?.memberIds.includes(profile.id));
  const mentions = group ? resolveChatMentions(chat.draft, roomProfiles, outsideProfiles) : { ids: [], unknown: [], broadcast: false };
  const currentRooms = chat.rooms.filter(item => !item.archived);
  const archives = chat.rooms.filter(item => item.archived);
  const recipients = group ? mentions.ids.length ? profiles.filter(profile => mentions.ids.includes(profile.id)) : roomProfiles : roomProfiles;
  const readyCount = recipients.filter(profile => agents.connectionCheck(profile)?.ok).length;
  const desktop = isTauri();
  const canSend = desktop && Boolean(room) && !room?.archived && !chat.sending && !chat.membersSaving && !membersOpen && recipients.length > 0 && Boolean(chat.draft.trim()) && !mentions.unknown.length;
  const pending = chat.history.messages.filter(message => message.role === 'assistant' && ['queued', 'running', 'interrupted'].includes(message.status));
  useEffect(() => { void chat.refresh(); }, [chat.refresh]);
  useEffect(() => {
    onInteractionChange(focused || picker || membersOpen || Boolean(chat.draft.trim()) || chat.sending || Boolean(retrying));
    return () => onInteractionChange(false);
  }, [focused, picker, membersOpen, chat.draft, chat.sending, retrying, onInteractionChange]);
  useEffect(() => { setPicker(false); setRetrying(null); setHistoryOpen(false); setMembersOpen(false); setMembersError(''); }, [chat.roomId]);
  useLayoutEffect(() => {
    const input = composer.current;
    if (input) { input.style.height = '0px'; input.style.height = Math.min(122, Math.max(58, input.scrollHeight)) + 'px'; }
  }, [chat.draft, chat.roomId]);
  useLayoutEffect(() => {
    nearBottom.current = true; setAwayFromBottom(false);
    if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [chat.roomId]);
  useLayoutEffect(() => {
    if (nearBottom.current && !chat.loadingOlder && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [chat.history.messages, chat.loading, chat.loadingOlder]);
  const scrollBottom = () => {
    nearBottom.current = true; setAwayFromBottom(false);
    transcript.current?.scrollTo({ top: transcript.current.scrollHeight, behavior: 'smooth' });
  };
  const send = async () => {
    if (!canSend || !room) return;
    setPicker(false); nearBottom.current = true;
    const missing = mentions.ids.filter(id => !room.memberIds.includes(id));
    if (missing.length && !await chat.updateMembers([...room.memberIds, ...missing])) return;
    if (await chat.send(chat.draft, mentions.ids)) composer.current?.focus();
  };
  const chooseMention = (id?: string) => {
    const name = id ? profiles.find(profile => profile.id === id)?.name : '所有助理';
    if (!name) return;
    const input = composer.current;
    const next = insertChatMention(chat.draft, name, input?.selectionStart, input?.selectionEnd);
    chat.setDraft(next.text); setPicker(false);
    requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(next.caret, next.caret); });
  };
  const older = async () => {
    const list = transcript.current, height = list?.scrollHeight || 0, top = list?.scrollTop || 0;
    nearBottom.current = false;
    await chat.loadOlder();
    requestAnimationFrame(() => { if (list && list === transcript.current) list.scrollTop = list.scrollHeight - height + top; });
  };
  const select = (next: ChatRoom) => { setFocused(false); chat.selectRoom(next.id); };
  const openMembers = () => { setSelectedMembers([...(room?.memberIds || [])]); setMembersError(''); setMembersOpen(true); setPicker(false); };
  const saveMembers = async () => {
    setMembersError('');
    const ids = selectedMembers.filter(id => profiles.some(profile => profile.id === id));
    if (!ids.length) { setMembersError('至少选择一位群成员。'); return; }
    try { if (await chat.updateMembers(ids)) setMembersOpen(false); }
    catch (cause) { setMembersError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const action = (message: ChatMessage, type: 'cancel' | 'retry' | 'sync') => { setRetrying(null); void chat.act(type, message); };
  const roomButton = (item: ChatRoom) => {
    const profile = profiles.find(candidate => item.memberIds.length === 1 && item.memberIds[0] === candidate.id);
    const active = chat.roomId === item.id;
    return <button key={item.id} className="pd-chat-room" role="tab" aria-selected={active} aria-controls="assistant-chat-transcript" data-room-id={item.id} data-room-kind={item.kind} onClick={() => select(item)} title={item.lastMessage || item.title}>
      <span className="pd-chat-avatar" data-provider={profile?.protocol}>{item.kind === 'group' ? <Users size={16}/> : avatar(profile?.protocol)}{profile && <i className={'pd-chat-presence ' + (agents.connectionCheck(profile)?.ok ? 'ready' : '')}/>}</span>
      <span>{item.title}</span>{item.pendingCount > 0 && <i className="pd-chat-pending-dot" aria-label={`${item.pendingCount} 条待处理`}/>}
    </button>;
  };
  return <section className="pd-chat" aria-label="助理聊天" data-room-kind={room?.kind}>
    <div className="pd-chat-rooms" role="tablist" aria-label="聊天会话">{currentRooms.map(roomButton)}</div>
    <header className="pd-chat-heading">
      <div><h2>{room?.title || '助理群'}{room?.archived ? <History size={12}/> : group ? <Users size={12}/> : <LockKeyhole size={12}/>}</h2>
        <p>{room?.archived ? '历史会话 · 只读' : group ? `${roomProfiles.length} 位助理 · 可输入 @ 指定回复` : '独立私聊会话'}</p></div>
      {group && !room?.archived && <button className="pd-icon" aria-label="管理群成员" title="群成员" disabled={!desktop || !room || chat.sending || chat.membersSaving} onClick={openMembers}><Users size={15}/></button>}
      {archives.length > 0 && <button className="pd-icon" aria-label="查看历史连接的私聊" aria-expanded={historyOpen} onClick={() => setHistoryOpen(value => !value)}><History size={15}/></button>}
      <button className="pd-icon" aria-label="管理助理连接" onClick={onConnections}><Settings2 size={15}/></button>
    </header>
    {historyOpen && <div className="pd-chat-archives" aria-label="历史连接私聊">{archives.map(item => <button key={item.id} onClick={() => select(item)}><History size={12}/><span>{item.title}</span><small>{item.updatedAt ? dayLabel(item.updatedAt) : ''}</small></button>)}</div>}
    {!desktop && <div className="pd-chat-notice">当前为浏览器预览，消息发送需在桌面端使用</div>}
    {chat.error && <div className="pd-chat-notice error" role="alert"><span>{chat.error}</span><button aria-label="刷新聊天记录" onClick={() => void chat.refresh()}><RefreshCw size={13}/></button></div>}
    <div className="pd-chat-transcript-wrap">
      <div ref={transcript} id="assistant-chat-transcript" className="pd-chat-transcript" role="log" aria-label={room?.title ? room.title + '消息记录' : '聊天记录'} aria-live="polite" aria-relevant="additions text" aria-busy={chat.loading}
        onScroll={() => { const element = transcript.current; if (!element) return; nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 65; setAwayFromBottom(!nearBottom.current); }}>
        {chat.history.hasMore && <button className="pd-chat-earlier" disabled={chat.loadingOlder} onClick={() => void older()}>{chat.loadingOlder ? <LoaderCircle size={12} className="pd-busy"/> : <History size={12}/>}更早的消息</button>}
        {chat.loading && !chat.history.messages.length ? <div className="pd-chat-empty"><LoaderCircle size={22} className="pd-busy"/><p>正在加载会话…</p></div>
          : !chat.history.messages.length ? <div className="pd-chat-empty"><span>{group ? <Users size={22}/> : <MessageCircle size={22}/>}</span><h3>{group ? '群聊暂无消息' : '暂无对话记录'}</h3><p>{group ? '发送消息讨论，或输入 @ 指定助理处理。' : `向 ${room?.title || '助理'} 发送消息开始对话。`}</p></div>
          : chat.history.messages.map((message, index, list) => {
            const profile = profiles.find(item => item.id === message.authorId);
            const active = ['queued', 'running', 'interrupted'].includes(message.status);
            const busy = Boolean(message.deliveryId && chat.busyDeliveries.includes(message.deliveryId));
            const dated = !index || new Date(message.createdAt).toDateString() !== new Date(list[index - 1].createdAt).toDateString();
            return <div key={message.id}>
              {dated && <div className="pd-chat-day">{dayLabel(message.createdAt)}</div>}
              <article className={'pd-chat-message ' + message.role} data-message-id={message.id} data-status={message.status}>
                {message.role === 'assistant' && <span className="pd-chat-avatar small" data-provider={profile?.protocol}>{avatar(profile?.protocol)}</span>}
                <div className="pd-chat-message-main">
                  <div className="pd-chat-message-meta"><strong>{message.role === 'user' ? '你' : message.authorName}</strong><time dateTime={new Date(message.createdAt).toISOString()}>{clock(message.createdAt)}</time></div>
                  {message.text && <div className="pd-chat-bubble">{message.text}</div>}
                  {message.role === 'user' && group && <div className="pd-chat-audience">{message.mentions.length ? message.mentions.map(id => '@' + (profiles.find(profile => profile.id === id)?.name || '原助理')).join(' · ') : '发给当时的本群成员'}</div>}
                  {message.role === 'assistant' && <>
                    {(active || message.status !== 'completed') && <div className={'pd-chat-delivery ' + (message.status === 'failed' || message.status === 'interrupted' ? 'attention' : '')}>
                      {message.status === 'running' ? <LoaderCircle size={12} className="pd-busy"/> : message.status === 'queued' ? <Clock3 size={12}/> : <span className="pd-chat-state-dot"/>}
                      <span>{message.attention?.title || message.progress || statusLabels[message.status]}</span>
                    </div>}
                    {message.error && <p className="pd-chat-message-error">{message.error}</p>}
                    <div className="pd-chat-message-actions">
                      {message.attention && message.runId && <button disabled={busy} onClick={() => agents.showResult(message.runId!)}>处理请求</button>}
                      {message.status === 'interrupted' && message.deliveryId && <button disabled={busy} onClick={() => action(message, 'sync')}><RefreshCw size={11}/>恢复同步</button>}
                      {active && message.deliveryId && <button disabled={busy} onClick={() => action(message, 'cancel')}><Square size={10}/>停止跟进</button>}
                      {message.status === 'failed' && message.deliveryId && !room?.archived && <button disabled={busy} onClick={() => setRetrying(message.id)}><RefreshCw size={11}/>重新请他处理</button>}
                      {message.status === 'failed' && profile && <button onClick={() => agents.configure(profile.id)}>检查连接</button>}
                      {busy && <LoaderCircle size={12} className="pd-busy" aria-label="正在处理操作"/>}
                    </div>
                    {retrying === message.id && <div className="pd-chat-retry"><p>将重新发送这条请求给 {message.authorName}。</p><button disabled={busy} onClick={() => action(message, 'retry')}>确认重试</button><button onClick={() => setRetrying(null)}>取消</button></div>}
                  </>}
                </div>
              </article>
            </div>;
          })}
      </div>
      {awayFromBottom && <button className="pd-chat-jump" onClick={scrollBottom}><ArrowDown size={12}/>最新消息</button>}
    </div>
    {room?.archived ? <div className="pd-chat-readonly"><LockKeyhole size={13}/>这份私聊已归档。切换到上方当前助理继续。</div> : <form className="pd-chat-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
      {picker && group && <div className="pd-chat-mention-picker" aria-label="选择要 @ 的助理"><div><strong>请谁来处理</strong><button type="button" aria-label="关闭助理选择" onClick={() => setPicker(false)}><X size={13}/></button></div>
        <button type="button" onClick={() => chooseMention()}><Users size={15}/><span>所有助理</span><small>一起讨论</small></button>
        {[...roomProfiles, ...outsideProfiles].map(profile => <button type="button" key={profile.id} onClick={() => chooseMention(profile.id)}><span className="pd-chat-avatar tiny" data-provider={profile.protocol}>{avatar(profile.protocol)}</span><span>{profile.name}</span>{mentions.ids.includes(profile.id) ? <Check size={13}/> : <small>{room?.memberIds.includes(profile.id) ? (agents.connectionCheck(profile)?.ok ? '已就绪' : '待连接') : '点名后加入本群'}</small>}</button>)}
      </div>}
      <div className="pd-chat-recipient-line"><span>{group ? mentions.ids.length ? '请 ' + recipients.map(profile => profile.name).join('、') + ' 回应' : '发给本群助理' : room?.title || '读取会话中'}</span><small>{pending.length ? `${pending.length} 条处理中` : `${readyCount}/${recipients.length} 已就绪`}</small></div>
      <textarea ref={composer} aria-label={group ? '发送到助理群' : '发送私聊消息'} placeholder={group ? '说说要做的事，输入 @ 指定助理…' : '发给' + (room?.title || '这位助理') + '…'} value={chat.draft} maxLength={12000} rows={2} disabled={!room || !desktop || chat.sending}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        onChange={event => { chat.setDraft(event.target.value); if (group && /(^|[^A-Za-z0-9_.+-])@$/.test(event.target.value.slice(0, event.target.selectionStart))) setPicker(true); }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === 'Escape' && picker) { event.preventDefault(); event.stopPropagation(); setPicker(false); return; }
          if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) { event.preventDefault(); void send(); }
        }}/>
      {mentions.unknown.length > 0 && <p className="pd-chat-mention-error" role="status">本群没有 {mentions.unknown.map(name => name === '@' ? '这位助理' : '@' + name).join('、')}，请从 @ 名单选择或先添加群成员。</p>}
      <div className="pd-chat-compose-actions"><div>{group && <button type="button" className="pd-icon" aria-label="@ 指定助理" aria-expanded={picker} onClick={() => setPicker(value => !value)} disabled={!desktop || !room}><AtSign size={16}/></button>}<span>Enter 发送 · Shift Enter 换行</span></div><button className="pd-chat-send" type="submit" disabled={!canSend} aria-label="发送消息">{chat.sending ? <LoaderCircle size={15} className="pd-busy"/> : <Send size={15}/>}</button></div>
    </form>}
    {membersOpen && group && <Sheet title="群成员" onClose={() => { if (!chat.membersSaving) setMembersOpen(false); }} actions={<>
      <button type="button" className="pd-secondary" disabled={chat.membersSaving} onClick={() => setMembersOpen(false)}>取消</button>
      <button type="button" className="pd-primary" disabled={chat.membersSaving || !selectedMembers.some(id => profiles.some(profile => profile.id === id))} onClick={() => void saveMembers()}>{chat.membersSaving ? <LoaderCircle size={13} className="pd-busy"/> : <Check size={13}/>}保存成员</button>
    </>}>
      <p className="pd-field-hint">未指定 @ 时，消息发给选中的本群成员。加入前的历史不会自动共享；新成员只接收加入后的消息和获授权的上下文。</p>
      <div className="pd-chat-members-list">{profiles.map(profile => <label key={profile.id} className="pd-chat-member-choice">
        <input type="checkbox" checked={selectedMembers.includes(profile.id)} disabled={chat.membersSaving} onChange={event => setSelectedMembers(current => event.target.checked ? [...current, profile.id] : current.filter(id => id !== profile.id))}/>
        <span className="pd-chat-avatar" data-provider={profile.protocol}>{avatar(profile.protocol)}</span>
        <span><strong>{profile.name}</strong><small>{agents.connectionCheck(profile)?.ok ? '已连接' : '待连接'}</small></span>
      </label>)}</div>
      <p className="pd-field-hint">保存成员不会发送消息；移除成员后，该助理不再接收新的群请求。</p>
      {(membersError || chat.error) && <p className="pd-inline-error" role="alert">{membersError || chat.error}</p>}
    </Sheet>}
  </section>;
}
