import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveChatMentions, insertChatMention } from '../src/lib/assistant-chat-mentions.mjs';
const profiles = [{ id: 'muse', name: 'Muse AI', protocol: 'muse-personal' }, { id: 'grok', name: 'Grok Bot', protocol: 'grok-direct' }, { id: 'dot', name: 'GPT · omdot', protocol: 'dots-direct' }];
test('recognizes complete names and aliases, deduplicating an explicitly targeted group', () => {
  assert.deepEqual(resolveChatMentions('@Grok Bot 调研，@muse整理，@Grok 复核', profiles), { ids: ['grok', 'muse'], unknown: [], broadcast: false });
  assert.deepEqual(resolveChatMentions('请@GPT · omdot 看看 @Moss AI 的意见', profiles).ids, ['dot', 'muse']);
});
test('unknown or partial mentions are not mistaken for broadcast or a prefix match', () => {
  assert.deepEqual(resolveChatMentions('@GrokOther 帮忙', profiles), { ids: [], unknown: ['GrokOther'], broadcast: false });
  assert.deepEqual(resolveChatMentions('@Grok 和 @未知助理', profiles).unknown, ['未知助理']);
  assert.deepEqual(resolveChatMentions('@', profiles).unknown, ['@']);
});
test('email addresses and ordinary messages do not create mentions', () => {
  assert.deepEqual(resolveChatMentions('发到 hello@muse.ai，继续安排', profiles), { ids: [], unknown: [], broadcast: false });
  assert.deepEqual(resolveChatMentions('今天先做什么？', profiles).ids, []);
});
test('Notion can be addressed by its short names without joining an unmentioned broadcast', () => {
  const notion = { id: 'notion', name: 'Notion AI', protocol: 'notion-web' };
  assert.deepEqual(resolveChatMentions('@notionai 看一下优先级', profiles, [notion]).ids, ['notion']);
  assert.deepEqual(resolveChatMentions('@NotionAI，帮我整理', profiles, [notion]).ids, ['notion']);
  assert.deepEqual(resolveChatMentions('@所有助理 各说一句', profiles, [notion]).ids, ['muse', 'grok', 'dot']);
});
test('explicit everyone includes precisely the current three identities', () => {
  assert.deepEqual(resolveChatMentions('@所有助理 各说一句', profiles).ids, ['muse', 'grok', 'dot']);
  assert.equal(resolveChatMentions('@all', profiles).broadcast, true);
});
test('mention insertion replaces a partial query and preserves text after cursor', () => {
  assert.deepEqual(insertChatMention('请 @gr 看一下', 'Grok Bot', 5, 5), { text: '请 @Grok Bot  看一下', caret: 12 });
  assert.deepEqual(insertChatMention('你好', 'Muse AI'), { text: '你好 @Muse AI ', caret: 12 });
});
test('an ambiguous renamed assistant cannot silently select the wrong identity', () => {
  const renamed = profiles.map(profile => ({ ...profile, name: '助理' }));
  assert.deepEqual(resolveChatMentions('@助理 帮我', renamed), { ids: [], unknown: ['助理（重名）'], broadcast: false });
});
