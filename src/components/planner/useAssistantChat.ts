import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentProfile } from '../../lib/agentHub';
import { appendPreparedDraft } from '../../lib/pmo-review.mjs';
import { chatDeliveryAction, chatHistory, listChatRooms, sendChatMessage, subscribeChats, updateChatMembers, type ChatHistory, type ChatMessage, type ChatRoom, type SendChatRequest } from '../../lib/assistantChat';

const emptyHistory: ChatHistory = { messages: [], hasMore: false };
function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]) {
  const all = new Map(current.map(message => [message.id, message]));
  for (const message of incoming) {
    const prior = all.get(message.id);
    if (!prior || message.updatedAt >= prior.updatedAt) all.set(message.id, message);
  }
  return [...all.values()].sort((a, b) => a.seq - b.seq);
}
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** Mounted above the drawer pages so switching rooms or folding preserves drafts. */
export function useAssistantChat(profiles: AgentProfile[], runtimeIdentityKey = '') {
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [roomId, setRoomId] = useState('team');
  const [histories, setHistories] = useState<Record<string, ChatHistory>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftsRef = useRef(drafts); draftsRef.current = drafts;
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [membersSaving, setMembersSaving] = useState(false);
  const membersLock = useRef(false);
  const [sending, setSending] = useState<string[]>([]);
  const [busyDeliveries, setBusyDeliveries] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [readErrors, setReadErrors] = useState<Record<string, string>>({});
  const [roomError, setRoomError] = useState('');
  const profilesRef = useRef(profiles); profilesRef.current = profiles;
  const roomIdRef = useRef(roomId); roomIdRef.current = roomId;
  const historiesRef = useRef(histories); historiesRef.current = histories;
  const mounted = useRef(true);
  const pendingSend = useRef(new Map<string, { signature: string; request: SendChatRequest }>());
  const sendLocks = useRef(new Set<string>());
  const operationLocks = useRef(new Set<string>());
  const historyReads = useRef(new Map<string, Promise<void>>());
  const historyDirty = useRef(new Set<string>());
  const roomRead = useRef<Promise<void> | null>(null);
  const roomsDirty = useRef(false);
  const olderLocks = useRef(new Set<string>());
  const profileKey = JSON.stringify(profiles.map(({ id, name, protocol, endpoint, model, agentRef, sessionId, webhookUrl }) => ({ id, name, protocol, endpoint, model, agentRef, sessionId, webhookUrl })));

  const refreshRooms = useCallback(async () => {
    if (roomRead.current) { roomsDirty.current = true; return roomRead.current; }
    const read = (async () => {
      do {
        roomsDirty.current = false;
        const routing = profilesRef.current;
        try {
          const next = await listChatRooms(routing);
          if (!mounted.current) return;
          // A changed profile must get its own identity-bound room before it can
          // replace the room list. A stale reply cannot win over new routing.
          if (JSON.stringify(routing) !== JSON.stringify(profilesRef.current)) { roomsDirty.current = true; continue; }
          setRooms(next); setRoomError('');
          setRoomId(current => next.some(room => room.id === current) ? current : next.find(room => room.kind === 'group')?.id || next[0]?.id || 'team');
        } catch (cause) { if (mounted.current) setRoomError(errorText(cause)); }
      } while (mounted.current && roomsDirty.current);
    })();
    roomRead.current = read;
    try { await read; } finally { if (roomRead.current === read) roomRead.current = null; }
  }, []);
  const refreshHistory = useCallback(async (id: string) => {
    if (historyReads.current.has(id)) { historyDirty.current.add(id); return historyReads.current.get(id); }
    const read = (async () => {
      do {
        historyDirty.current.delete(id);
        try {
          const next = await chatHistory(id);
          if (!mounted.current) return;
          setHistories(current => {
            const old = current[id];
            const olderLoaded = Boolean(old?.messages.length && next.messages.length && old.messages[0].seq < next.messages[0].seq);
            return { ...current, [id]: { messages: mergeMessages(old?.messages || [], next.messages),
              hasMore: olderLoaded && old ? old.hasMore : next.hasMore, nextBefore: olderLoaded && old ? old.nextBefore : next.nextBefore } };
          });
          setReadErrors(current => ({ ...current, [id]: '' }));
        } catch (cause) { if (mounted.current) setReadErrors(current => ({ ...current, [id]: errorText(cause) })); }
      } while (mounted.current && historyDirty.current.has(id));
    })();
    historyReads.current.set(id, read);
    try { await read; } finally { if (historyReads.current.get(id) === read) historyReads.current.delete(id); }
  }, []);
  const refresh = useCallback(async () => {
    setErrors(current => ({ ...current, [roomIdRef.current]: '' }));
    await refreshRooms(); await refreshHistory(roomIdRef.current);
  }, [refreshRooms, refreshHistory]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  // Login and workspace changes can rebind identity without changing a profile.
  // Keep any old draft in its archived room; never forward it to the new account.
  useEffect(() => { void refreshRooms(); }, [profileKey, runtimeIdentityKey, refreshRooms]);
  const roomKnown = rooms.some(room => room.id === roomId);
  useEffect(() => {
    let disposed = false; setLoading(true); setLoadingOlder(false);
    if (!roomKnown) return () => { disposed = true; };
    void refreshHistory(roomId).finally(() => { if (!disposed && mounted.current) setLoading(false); });
    return () => { disposed = true; };
  }, [roomId, roomKnown, refreshHistory]);
  useEffect(() => {
    let disposed = false, unlisten: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = new Set<string>();
    void subscribeChats((id, message) => {
      // An old in-flight reply may be outside the newest history page. Apply
      // its actual event snapshot to already loaded history before refreshing.
      if (id && message && message.roomId === id) setHistories(current => current[id]
        ? { ...current, [id]: { ...current[id], messages: mergeMessages(current[id].messages, [message]) } } : current);
      if (id) changed.add(id);
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined; if (disposed) return;
        void refreshRooms();
        if (!changed.size || changed.has(roomIdRef.current)) void refreshHistory(roomIdRef.current);
        changed.clear();
      }, 100);
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(cause => {
      if (!disposed) setRoomError(errorText(cause));
    });
    return () => { disposed = true; clearTimeout(timer); unlisten?.(); };
  }, [refreshHistory, refreshRooms]);
  const loadOlder = useCallback(async () => {
    const id = roomIdRef.current, previous = historiesRef.current[id];
    if (!previous?.hasMore || previous.nextBefore == null || olderLocks.current.has(id)) return;
    olderLocks.current.add(id);
    setLoadingOlder(true);
    try {
      const next = await chatHistory(id, previous.nextBefore);
      if (mounted.current) setHistories(current => ({ ...current, [id]: { ...next, messages: mergeMessages(next.messages, current[id]?.messages || []) } }));
    } catch (cause) { if (mounted.current) setReadErrors(current => ({ ...current, [id]: errorText(cause) })); }
    finally { olderLocks.current.delete(id); if (mounted.current && roomIdRef.current === id) setLoadingOlder(false); }
  }, []);
  const setDraft = useCallback((text: string) => {
    const id = roomIdRef.current; draftsRef.current = { ...draftsRef.current, [id]: text }; setDrafts(draftsRef.current);
  }, []);
  const prepareDraft = useCallback((id: string, text: string) => {
    const prepared = appendPreparedDraft(draftsRef.current[id] || '', text);
    roomIdRef.current = id; setRoomId(id);
    if (!prepared.appended) { setErrors(current => ({ ...current, [id]: prepared.error })); return false; }
    draftsRef.current = { ...draftsRef.current, [id]: prepared.text }; setDrafts(draftsRef.current);
    setErrors(current => ({ ...current, [id]: '' })); return true;
  }, []);
  const send = useCallback(async (text: string, mentions: string[]) => {
    const id = roomIdRef.current;
    if (!text.trim() || sendLocks.current.has(id)) return false;
    sendLocks.current.add(id); setSending(current => [...current, id]);
    setErrors(current => ({ ...current, [id]: '' }));
    const routing = profilesRef.current;
    const signature = JSON.stringify({ text, mentions, profiles: routing });
    let pending = pendingSend.current.get(id);
    if (!pending || pending.signature !== signature) {
      pending = { signature, request: { roomId: id, clientMessageId: 'chat-' + crypto.randomUUID(), text, mentions, profiles: routing.map(profile => ({ ...profile })) } };
      pendingSend.current.set(id, pending);
    }
    try {
      await sendChatMessage(pending.request);
      pendingSend.current.delete(id);
      if (mounted.current) setDrafts(current => current[id] === text ? { ...current, [id]: '' } : current);
      await refreshRooms(); await refreshHistory(id); return true;
    } catch (cause) {
      if (mounted.current) setErrors(current => ({ ...current, [id]: errorText(cause) }));
      return false;
    } finally {
      sendLocks.current.delete(id);
      if (mounted.current) setSending(current => current.filter(item => item !== id));
    }
  }, [refreshHistory, refreshRooms]);
  const act = useCallback(async (action: 'cancel' | 'retry' | 'sync', message: ChatMessage) => {
    if (!message.deliveryId || operationLocks.current.has(message.deliveryId)) return;
    const id = message.deliveryId;
    operationLocks.current.add(id); setBusyDeliveries(current => [...current, id]);
    setErrors(current => ({ ...current, [message.roomId]: '' }));
    try {
      const updated = await chatDeliveryAction(action, id);
      if (mounted.current) setHistories(current => ({ ...current, [updated.roomId]: { ...(current[updated.roomId] || emptyHistory), messages: mergeMessages(current[updated.roomId]?.messages || [], [updated]) } }));
      await refreshRooms(); await refreshHistory(message.roomId);
    } catch (cause) { if (mounted.current) setErrors(current => ({ ...current, [message.roomId]: errorText(cause) })); }
    finally { operationLocks.current.delete(id); if (mounted.current) setBusyDeliveries(current => current.filter(item => item !== id)); }
  }, [refreshHistory, refreshRooms]);
  const updateMembers = useCallback(async (memberIds: string[]) => {
    if (membersLock.current) return false;
    membersLock.current = true; setMembersSaving(true);
    setErrors(current => ({ ...current, team: '' }));
    try {
      const next = await updateChatMembers(profilesRef.current, memberIds);
      if (mounted.current) setRooms(next);
      return true;
    } catch (cause) {
      if (mounted.current) setErrors(current => ({ ...current, team: errorText(cause) }));
      return false;
    } finally { membersLock.current = false; if (mounted.current) setMembersSaving(false); }
  }, []);
  return { profiles, rooms, roomId, room: rooms.find(room => room.id === roomId), selectRoom: setRoomId,
    history: histories[roomId] || emptyHistory, draft: drafts[roomId] || '', setDraft, prepareDraft,
    loading, loadingOlder, loadOlder, sending: sending.includes(roomId), busyDeliveries,
    error: errors[roomId] || readErrors[roomId] || roomError, refresh, send, act, updateMembers, membersSaving };
}
