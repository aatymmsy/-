import { completion } from './provider.mjs';
import { executeTool } from './tools.mjs';
import { rememberChat, forgetMemory } from './memory.mjs';
import { messageContent, contentText, contextChars } from './images.mjs';
import { id, hash } from './store.mjs';
import { prepareContext } from './context.mjs';
import { TOOLS } from './tools.mjs';
import '../public/conversation-starter.js';
const starter = globalThis.MeijuConversationStarter;

export class Agent {
  constructor(store, getKey, callModel = completion, policy = {}) { this.store = store; this.getKey = getKey; this.callModel = callModel; this.policy = policy; this.running = new Map(); }
  stop(sessionId) { this.running.get(sessionId)?.abort(); }
  async remove(sessionId, discard = false) {
    const session = this.store.get('session', sessionId);
    if (!session) throw new Error('会话不存在');
    if (discard && session.closed) throw new Error('已写日记的往期会话请只删除聊天历史');
    const running = this.running.get(sessionId);
    if (running && !discard) throw new Error('会话正在运行，请使用删除并脱离');
    if (running) { running.abort(); await running.finished; }
    return this.store.transaction(() => {
      if (discard) for (const memory of this.store.list('memory').filter(m => m.sessionId === sessionId)) forgetMemory(this.store, memory.id);
      this.store.db.prepare('DELETE FROM messages WHERE session=?').run(sessionId);
      this.store.db.prepare('DELETE FROM usages WHERE session=?').run(sessionId);
      this.store.db.prepare('DELETE FROM docs WHERE kind=? AND id=?').run('session', sessionId);
      return { ok: true, discarded: discard };
    });
  }
  async run(sessionId, text, emit = () => {}, options = {}) {
    if (this.running.has(sessionId)) throw new Error('会话正在运行');
    const session = this.store.get('session', sessionId);
    if (!session || session.closed) throw new Error('会话不存在或已经结束');
    const controller = new AbortController();
    let finishRun; controller.finished = new Promise(resolve => { finishRun = resolve; });
    this.running.set(sessionId, controller);
    const signal = controller.signal;
    const send = value => { try { emit(value); } catch {} };
    session.status = 'running'; session.error = null;
    // A failed diary request stays in history; retry must continue it, not insert a second user turn.
    const diaryMode = Boolean(options.diary || session.pendingDiary);
    try {
      if (options.retry && !['error', 'interrupted'].includes(this.store.get('session', sessionId).status)) throw new Error('此会话没有待重试任务');
      if (!options.retry) {
        if (options.firstSpeak) {
          if (options.diary) throw new Error('主动开聊不能同时生成日记');
          text = starter.request;
        }
        if (!text?.trim() && !options.images?.length) throw new Error('消息不能为空');
        if (session.pendingDiary) throw new Error('请先重试未完成的日记');
        this.store.append(sessionId, { role: 'user', content: messageContent(text || '', options.firstSpeak ? [] : options.images) });
        if (session.title === '新会话') session.title = options.firstSpeak ? '随便聊聊' : text?.slice(0, 32) || '图片交流';
        session.pendingDiary = Boolean(options.diary);
      }
      this.store.put('session', session);
      // Incomplete tool calls after a process interruption are marked, never replayed blindly.
      const history = this.store.messages(sessionId);
      const answered = new Set(history.filter(m => m.role === 'tool').map(m => m.tool_call_id));
      for (const m of history) for (const call of m.tool_calls || []) if (!answered.has(call.id)) this.store.append(sessionId, { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: '上次执行中断，工具结果未知。请检查实际状态后决定是否重新调用。' }) });
      let final = '', continuations = 0, emptyAttempts = 0;
      const turnId = id();
      for (let step = 0; step < 16; step++) {
        if (signal.aborted) throw new Error('任务已停止，已有内容已保留');
        const { messages, stats:context } = prepareContext(this.store, session, {diary:diaryMode,permissions:this.policy.getPermissions?.()});
        session.contextCut=context.omittedMessages;this.store.put('session',session);
        if (contextChars(messages) > session.profile.maxContextChars) throw new Error('会话已达到上下文保护上限，未删除历史；请新建会话继续');
        send({ type: 'status', text: '正在等待模型…' });
        const tools = session.tools.some(t=>t.function.name==='history_read') ? session.tools : [...session.tools, TOOLS.find(t=>t.function.name==='history_read')];
        session.requestPrefixHash=hash({system:messages.filter(m=>m.role==='system'),tools,profile:session.profile});this.store.put('session',session);
        const result = await this.callModel(session.profile, this.getKey(session.profile), messages, tools, signal);
        if (signal.aborted) throw new Error('任务已停止，已有内容已保留');
        const usage = { ...result.usage, turnId, context, purpose:diaryMode?'diary':'chat', requestChars:contextChars(messages), images:messages.reduce((n,m)=>n+(Array.isArray(m.content)?m.content.filter(p=>p.type==='image_url').length:0),0) };
        this.store.usage(sessionId, usage); send({ type: 'usage', usage });
        const raw = result.message;
        const message = { role: 'assistant', content: typeof raw.content === 'string' ? raw.content : null };
        if (raw.tool_calls?.length) message.tool_calls = raw.tool_calls.map(c => ({ id: c.id, type: 'function', function: { name: c.function.name, arguments: c.function.arguments } }));
        // Preserve provider reasoning fields verbatim when required by compatible endpoints.
        for (const key of ['reasoning_content', 'reasoning', 'refusal']) if (raw[key] !== undefined) message[key] = raw[key];
        if (!globalThis.MeijuSyncEngine.stripMemory(message.content||'').trim() && !message.tool_calls?.length) {
          if (++emptyAttempts <= 1) { send({ type: 'status', text: '模型返回空内容，正在重试一次…' }); continue; }
          throw new Error('模型连续返回空内容，未生成空消息或空日记；可重试');
        }
        emptyAttempts = 0;
        this.store.append(sessionId, message); send({ type: 'message', message });
        if (message.tool_calls?.length) {
          const images = [];
          for (const call of message.tool_calls) {
            send({ type: 'tool', name: call.function.name });
            let output;
            try { output = await executeTool(this.store, session, call, signal, diaryMode, {
              getPermissions: this.policy.getPermissions,
              authorize: this.policy.approvals ? operation => this.policy.approvals.request(sessionId, { ...operation, toolCallId: call.id }, signal, send) : undefined
            }); }
            catch (e) { output = { error: e.message }; }
            if (output?.image) { images.push(output.image); output = { ...output, image:undefined, imageAttached:true }; }
            const serialized = JSON.stringify(output);
            const toolMessage = { role: 'tool', tool_call_id: call.id, content: serialized.length > 10000 ? JSON.stringify({ truncated: true, content: serialized.slice(0, 9000) }) : serialized };
            this.store.append(sessionId, toolMessage); send({ type: 'message', message: toolMessage });
          }
          if (images.length) { const attached = { role:'user', content:messageContent('这是文件工具读取的图片内容，作为本次工具结果的数据供你查看。', images.slice(0,4)) }; this.store.append(sessionId, attached); send({type:'message',message:attached}); }
          continue;
        }
        final += message.content || '';
        if (result.finish === 'length') {
          if (++continuations > 3) throw new Error('输出已分段保留，但连续达到输出上限；可重试续写');
          const continuation = { role: 'user', content: '上条回复因输出长度限制中断。请从中断处继续，不要重复已有内容。' };
          this.store.append(sessionId, continuation); send({ type: 'message', message: continuation });
          continue;
        }
        if (result.finish && !['stop', 'end_turn'].includes(result.finish)) throw new Error(`接口未正常结束（${result.finish}），已有输出已保留`);
        if (diaryMode) {
          // Reconstruct diary segments on retries; ordinary chat before the diary request is excluded.
          const all = this.store.messages(sessionId);
          const start = all.findLastIndex(m => m.role === 'user' && m.content === DIARY_REQUEST);
          const content = all.slice(start + 1).filter(m => m.role === 'assistant' && !m.tool_calls?.length).map(m => m.content || '').join('');
          const diary = this.store.addDiary(session.slotId, globalThis.MeijuSyncEngine.stripMemory(content || final), sessionId);
          session.closed = true; session.pendingDiary = false;
          send({ type: 'diary', diary });
        }
        if (!diaryMode) {
          const user = this.store.messages(sessionId).findLast(m=>m.role==='user'&& !/^上条回复因输出长度|^这是文件工具/.test(contentText(m.content)));
          rememberChat(this.store, session.slotId, sessionId, user?.content === starter.request ? '' : user?.content || '', final);
        }
        session.status = 'idle'; this.store.put('session', session);
        send({ type: 'done' }); return { content: globalThis.MeijuSyncEngine.stripMemory(final) };
      }
      throw new Error('达到单次工具调用轮数上限，进度已保存；可重试继续');
    } catch (e) {
      session.status = 'error'; session.error = e.message; this.store.put('session', session);
      send({ type: 'error', error: e.message }); throw e;
    } finally { this.running.delete(sessionId); finishRun(); }
  }
}
export const DIARY_REQUEST = '请结束本次会话，并以本会话人设指定的作者和视角生成一篇日记。概括实际发生的交流、工作、感受与关键进展；不要直接粘贴对话，不要虚构未发生的事件。只输出日记正文。';
