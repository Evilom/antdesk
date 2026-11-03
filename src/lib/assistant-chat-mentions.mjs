const aliasesFor = profile => {
  const common = profile.protocol === 'muse-personal' ? ['Muse AI', 'MuseAI', 'Muse', 'Moss AI', 'MossAI', 'Moss']
    : profile.protocol === 'grok-direct' ? ['Grok Bot', 'GrokBot', 'Grok']
    : profile.protocol === 'dots-direct' ? ['GPT · omdot', 'omdot', 'GPT', 'Dots', 'Dot']
    : profile.protocol === 'notion-web' ? ['Notion AI', 'NotionAI', 'notionai', 'Notion'] : [];
  return [...new Set([profile.name, ...common].filter(Boolean))];
};
const boundary = value => !value || !/[A-Za-z0-9_-]/.test(value);

/** Unknown @names never silently broaden a targeted message to the whole group.
 * `extras` can be addressed by name without joining an unmentioned broadcast. */
export function resolveChatMentions(text, profiles, extras = []) {
  const addressable = [...profiles];
  for (const extra of extras) if (!addressable.some(profile => profile.id === extra.id)) addressable.push(extra);
  const aliases = addressable.flatMap(profile => aliasesFor(profile).map(name => ({ name, id: profile.id })))
    .sort((a, b) => b.name.length - a.name.length);
  const everyone = ['所有助理', '所有人', '全体', '全部', 'all', 'everyone'];
  const ids = new Set(), unknown = []; let broadcast = false;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '@' || index > 0 && /[A-Za-z0-9_.+-]/.test(text[index - 1])) continue;
    const after = text.slice(index + 1), lower = after.toLocaleLowerCase();
    const all = everyone.find(name => lower.startsWith(name) && boundary(after[name.length]));
    if (all) { broadcast = true; index += all.length; continue; }
    const matches = aliases.filter(item => lower.startsWith(item.name.toLocaleLowerCase()) && boundary(after[item.name.length]));
    const match = matches[0];
    if (match) {
      const owners = new Set(matches.filter(item => item.name.length === match.name.length).map(item => item.id));
      if (owners.size > 1) unknown.push(match.name + '（重名）'); else ids.add(match.id);
      index += match.name.length; continue;
    }
    const name = after.match(/^[^\s@,，。.!！?？:：;；()（）【】\[\]]*/u)?.[0] || '';
    unknown.push(name.slice(0, 80) || '@'); index += name.length;
  }
  return { ids: broadcast ? profiles.map(profile => profile.id) : [...ids], unknown: [...new Set(unknown)], broadcast };
}

export function insertChatMention(text, name, selectionStart = text.length, selectionEnd = selectionStart) {
  const before = text.slice(0, selectionStart), after = text.slice(selectionEnd);
  const partial = /(^|[^A-Za-z0-9_.+-])@[^@\s]*$/u.exec(before);
  const start = partial ? before.length - partial[0].length + partial[1].length : selectionStart;
  const prefix = text.slice(0, start);
  const space = prefix && !/\s$/.test(prefix) ? ' ' : '';
  const insertion = space + '@' + name + ' ';
  return { text: prefix + insertion + after, caret: prefix.length + insertion.length };
}
