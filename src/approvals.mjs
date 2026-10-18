import { id } from './store.mjs';

// Approval grants are local, single-use and bound to an immutable operation.
// Restarting never replays an action that was awaiting a decision.
export class Approvals {
  constructor(store) {
    this.store = store;
    this.pending = new Map();
    for (const entry of store.list('approval').filter(a => a.status === 'pending')) {
      store.put('approval', { ...entry, status: 'cancelled', decidedAt: Date.now() });
    }
  }
  list(sessionId) {
    return [...this.pending.values()].filter(p => p.entry.sessionId === sessionId).map(p => structuredClone(p.entry));
  }
  request(sessionId, operation, signal, emit = () => {}) {
    if (signal?.aborted) return Promise.reject(new Error('任务已停止'));
    const entry = this.store.put('approval', { ...structuredClone(operation), id: id(), sessionId, status: 'pending', createdAt: Date.now() });
    return new Promise((resolve, reject) => {
      let timer;
      const finish = status => {
        if (!this.pending.delete(entry.id)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        this.store.put('approval', { ...entry, status, decidedAt: Date.now() });
        emit({ type: 'approval_result', id: entry.id, status });
        if (status === 'approved') resolve(true);
        else reject(new Error(status === 'denied' ? '用户拒绝此操作，未执行。不要换用其他工具绕过；请等待用户的新指示。' : status === 'expired' ? '操作确认已过期，未执行；需要用户重新确认。' : '任务已停止，待确认操作未执行。'));
      };
      const abort = () => finish('cancelled');
      this.pending.set(entry.id, { entry, finish });
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish('expired'), 15 * 60 * 1000); timer.unref();
      if (signal?.aborted) abort();
      else emit({ type: 'approval', approval: structuredClone(entry) });
    });
  }
  decide(approvalId, decision) {
    if (!['approve', 'deny'].includes(decision)) throw new Error('请选择允许这一次或拒绝');
    const pending = this.pending.get(approvalId);
    if (!pending) { const error = new Error('此操作已处理、取消或过期，请刷新'); error.status = 409; throw error; }
    pending.finish(decision === 'approve' ? 'approved' : 'denied');
    return { ok: true };
  }
}
