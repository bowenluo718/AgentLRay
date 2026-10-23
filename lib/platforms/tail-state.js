'use strict';

// =====================================================================
// 平台无关的"会话尾部证据"小型状态机。
//
// 各平台元数据解析器在单遍扫描时，把观察到的事件喂进这里；扫描结束后
// 用 finishTail() 得到 lib/status.js deriveStatus 需要的 tail 对象：
//   {
//     lastAssistantAt, // ISO|null  最后一条 assistant（agent 输出）时间
//     lastPromptAt,    // ISO|null  最后一条"真实用户 prompt"时间
//     endTurnAt,       // ISO|null  最后一条"回合完成"标记时间（仅回合结束，非会话关闭）
//     endedAt,         // ISO|null  会话已显式关闭标记时间（session_exit / ended_at）
//     pendingToolAt,   // ISO|null  最旧的未应答工具调用时间
//   }
//
// 关键语义（P0 设计审查 #重要-1）：
//   - endedAt 只能来自"会话级关闭"标记；endTurnAt 只能来自"回合级结束"标记。
//     把回合结束喂给 endedAt 会把每轮正常结束的活跃会话误判为 stopped。
// =====================================================================

function createTailState() {
  return {
    lastAssistantAt: null,
    lastPromptAt: null,
    endTurnAt: null,
    endedAt: null,
    pendingByTs: new Map(), // toolCallId -> 首次出现时间戳（未应答调用）
  };
}

function tsMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function laterThan(existing, candidate) {
  const existingMs = tsMs(existing);
  const candidateMs = tsMs(candidate);
  if (candidateMs === null) return existing;
  if (existingMs === null) return candidate;
  return candidateMs > existingMs ? candidate : existing;
}

function noteAssistant(state, ts) {
  state.lastAssistantAt = laterThan(state.lastAssistantAt, ts);
}

function notePrompt(state, ts) {
  state.lastPromptAt = laterThan(state.lastPromptAt, ts);
}

function noteEndTurn(state, ts) {
  state.endTurnAt = laterThan(state.endTurnAt, ts);
}

function noteEnded(state, ts) {
  state.endedAt = laterThan(state.endedAt, ts);
}

/** 记录一个未应答工具调用（幂等：同一 id 保留首次时间）。 */
function addPending(state, id, ts) {
  if (id === null || id === undefined || id === '') return;
  if (!state.pendingByTs.has(id)) state.pendingByTs.set(id, ts);
}

/** 工具结果返回，清除对应待应答调用。 */
function resolvePending(state, id) {
  if (id === null || id === undefined || id === '') return;
  state.pendingByTs.delete(id);
}

function finishTail(state) {
  let oldest = null;
  let oldestMs = null;
  let newestMs = null;
  for (const ts of state.pendingByTs.values()) {
    const ms = tsMs(ts);
    if (ms === null) continue;
    if (oldestMs === null || ms < oldestMs) {
      oldestMs = ms;
      oldest = ts;
    }
    if (newestMs === null || ms > newestMs) newestMs = ms;
  }
  const newest = newestMs === null ? null : new Date(newestMs).toISOString();
  return {
    lastAssistantAt: state.lastAssistantAt,
    lastPromptAt: state.lastPromptAt,
    endTurnAt: state.endTurnAt,
    endedAt: state.endedAt,
    // pendingToolAt = 最旧未应答调用（awaiting-input 锚；csm ompPendingTool 同用最旧）
    pendingToolAt: oldest,
    // pendingNewestAt = 最新未应答调用（"正在执行"新鲜度锚，防旧残留把新活动误判老化）
    pendingNewestAt: newest,
  };
}

/**
 * 取文件的 mtimeMs（空会话/启动中分支需要；不能解析时返回 null，不抛错）。
 */
async function fileMtimeMs(filePath, fsp) {
  try {
    const st = await fsp.stat(filePath);
    return st.mtimeMs;
  } catch {
    return null;
  }
}

module.exports = {
  createTailState,
  noteAssistant,
  notePrompt,
  noteEndTurn,
  noteEnded,
  addPending,
  resolvePending,
  finishTail,
  fileMtimeMs,
};
