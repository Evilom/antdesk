// Web voice relay messages are user turns, not silent session updates.
// Retrieve only for explicit requests, and attach facts at most once per utterance.
export function voiceContextIntent(text) {
  if (/^(?:请)?(?:帮我)?记住[：:，,\s]*(?!了吗[？?。]*$|吗[？?。]*$|了没[？?。]*$)(.+)/s.test(text.trim())) return 'remember';
  const topic = /目录|文件|codex|工作|状态|宠物|进度|记忆|记得|之前|以前|昨天|上次|项目|汇报|今天|上午|下午|一天|刚才|节点|软著|番薯|构建|测试|git|ci|下一步|做到哪|接下来|进展|交付|最新情况|知识|资料|文档|hermes/i;
  const request = /[？?]|什么|怎么|如何|怎样|哪里|哪些|多少|几[个天次项]|有没有|是否|了吗|了没|做了啥|做到哪|到哪了|能否|帮我|请|查一下|查查|看一下|看看|告诉我|汇报|总结|回顾|还记得|还记不记得/i;
  return topic.test(text) && request.test(text) ? 'lookup' : null;
}

export class VoiceContextQueue {
  constructor(delay = 1500) { this.delay = delay; this.revision = 0; this.delivered = new Set(); }
  observe(caption, prepare, deliver, onError) {
    if (this.delivered.has(caption.id)) return;
    const key = `${caption.id}:${caption.text}`;
    if (key === this.last) return;
    if (this.lastId && this.lastId !== caption.id) this.closeTurn(this.lastId);
    clearTimeout(this.timer); this.revision++; this.last = key; this.lastId = caption.id;
    const revision = this.revision;
    const intent = voiceContextIntent(caption.text);
    if (!caption.id || !intent || this.delivered.has(caption.id)) return;
    const current = () => revision === this.revision;
    this.timer = setTimeout(async () => {
      try {
        const text = await prepare(intent, current);
        if (!current() || !text) return;
        deliver(text);
        this.closeTurn(caption.id);
      } catch (error) { if (current()) onError(error); }
    }, this.delay);
  }
  closeTurn(id) {
    this.delivered.add(id);
    if (this.delivered.size > 256) this.delivered.delete(this.delivered.values().next().value);
  }
  cancel() { clearTimeout(this.timer); this.revision++; this.last = ''; if (this.lastId) this.closeTurn(this.lastId); }
  reset() { this.cancel(); this.delivered.clear(); this.lastId = ''; }
}

export const VOICE_TURN_RULES = '正常回答用户的实际问题，不要反复称呼大师，不要用“我在”“我在听”“请继续”作为占位回复。客户端资料不是用户再次发言，不逐条确认收到，不朗读内部字段；没有新问题或有意义的新结果时保持安静。';
export function voiceSessionContext(facts, history, brief = false) {
  const header = `${VOICE_TURN_RULES}\n【客户端会话背景，仅供参考】\n`;
  const tail = `\n近期对话（不重复回答）：${history.slice(0,650)}\n【背景结束】\n${brief ? '用户点击了听汇报：请根据已核实资料简短汇报今日进度、阻塞和下一步。' : '现在没有新的用户问题。这条背景消息无需回复或问候，等用户实际发言后再回答。'}`;
  return header + facts.slice(0, 8000 - header.length - tail.length) + tail;
}
export function voiceLookupContext(question, facts) {
  const header = `${VOICE_TURN_RULES}\n【客户端对当前问题的检索结果】\n原问题：${question.slice(0, 500)}\n`;
  const tail = '\n【资料结束】\n只回答原问题或补充尚未说过的有效事实；如果原问题已完整回答，就保持安静。不重复问候、不复述这条客户端消息。';
  return header + facts.slice(0, 8000 - header.length - tail.length) + tail;
}
