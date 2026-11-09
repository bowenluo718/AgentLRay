const { makeMessage } = require('@agentlray/shared/helpers');
const { sortSessionsByStatusGroups } = require('@agentlray/shared/status');
// hermes 会话库读取机制随平台内聚（见 ./db.js）。
const {
  getHermesDbPath,
  openHermesDb,
  openHermesDbForWatch,
  unixToIso,
} = require('./db');

function listHermesSessions(dir) {
  const db = openHermesDb(dir);
  if (!db) return [];
  try {
    const sessions = db
      .prepare(`
      SELECT s.id, s.source, s.user_id, s.model, s.title, s.started_at, s.ended_at,
             s.message_count, s.tool_call_count, s.input_tokens, s.output_tokens,
             s.estimated_cost_usd, s.parent_session_id
      FROM sessions s
    `)
      .all();

    if (sessions.length === 0) return [];

    // One query: aggregate all per-session stats from messages
    const stats = db
      .prepare(`
      SELECT session_id,
             SUM(CASE WHEN role='user' THEN 1 ELSE 0 END) as user_count,
             SUM(CASE WHEN role='assistant' THEN 1 ELSE 0 END) as assistant_count,
             SUM(CASE WHEN role='tool' THEN 1 ELSE 0 END) as tool_result_count,
             MAX(timestamp) as last_ts
      FROM messages
      GROUP BY session_id
    `)
      .all();
    const statsMap = new Map(stats.map((r) => [r.session_id, r]));

    // First user message per session (one query)
    const firstUsers = db
      .prepare(`
      SELECT session_id, content FROM messages
      WHERE role = 'user' AND rowid IN (
        SELECT MIN(rowid) FROM messages WHERE role = 'user' GROUP BY session_id
      )
    `)
      .all();
    const firstUserMap = new Map(firstUsers.map((r) => [r.session_id, r.content]));

    // Last user/assistant message per session (one query)
    const lastMessages = db
      .prepare(`
      SELECT session_id, role, content FROM messages
      WHERE role IN ('user','assistant') AND trim(content) != ''
        AND rowid IN (
          SELECT MAX(rowid) FROM messages WHERE role IN ('user','assistant') GROUP BY session_id
        )
    `)
      .all();
    const lastMessageMap = new Map(
      lastMessages.map((r) => [r.session_id, { role: r.role, text: String(r.content).trim() }])
    );

    // Tail 证据：每个会话最后 assistant/user 消息时间（用于 Status 推导）
    const tailRows = db
      .prepare(`
      SELECT m.session_id,
             MAX(CASE WHEN m.role='assistant' THEN m.timestamp END) as last_assistant_ts,
             MAX(CASE WHEN m.role='user' THEN m.timestamp END) as last_prompt_ts
      FROM messages m
      GROUP BY m.session_id
    `)
      .all();
    const tailMap = new Map(tailRows.map((r) => [r.session_id, r]));

    // 每个会话最后一条 assistant 消息：按 tool_call_id 配对判断未应答（不按时间戳比较，
    // 避免同秒工具结果误判；用"该 call id 是否有任何 tool 行应答"做集合包含）。
    const lastAssistantRows = db
      .prepare(`
      SELECT session_id, id, timestamp, tool_calls
      FROM messages
      WHERE role = 'assistant'
        AND id = (
          SELECT MAX(id) FROM messages m2
          WHERE m2.session_id = messages.session_id AND m2.role = 'assistant'
        )
    `)
      .all();
    const pendingMap = new Map();
    for (const row of lastAssistantRows) {
      let callIds = [];
      try {
        const calls = JSON.parse(row.tool_calls);
        if (Array.isArray(calls)) callIds = calls.map((tc) => tc && tc.id).filter(Boolean);
      } catch {
        callIds = [];
      }
      if (callIds.length === 0) continue;
      const placeholders = callIds.map(() => '?').join(',');
      const answered = new Set(
        db
          .prepare(
            `SELECT DISTINCT tool_call_id FROM messages WHERE session_id = ? AND role = 'tool' AND tool_call_id IN (${placeholders})`
          )
          .all(row.session_id, ...callIds)
          .map((r) => r.tool_call_id)
      );
      if (callIds.some((id) => !answered.has(id))) {
        pendingMap.set(row.session_id, unixToIso(row.timestamp));
      }
    }

    // Top tools per session (parse tool_calls JSON from assistant messages)
    const toolCallRows = db
      .prepare(`
      SELECT session_id, tool_calls FROM messages
      WHERE role = 'assistant' AND tool_calls IS NOT NULL AND tool_calls != ''
    `)
      .all();
    const toolMap = new Map();
    const spawnMap = new Map();
    for (const row of toolCallRows) {
      let calls;
      try {
        calls = JSON.parse(row.tool_calls);
      } catch {
        continue;
      }
      if (!Array.isArray(calls)) continue;
      for (const tc of calls) {
        const name = tc?.function?.name || tc?.name;
        if (!name) continue;
        if (!toolMap.has(row.session_id)) toolMap.set(row.session_id, new Map());
        const sessionTools = toolMap.get(row.session_id);
        sessionTools.set(name, (sessionTools.get(name) || 0) + 1);
        if (name === 'delegate_task') {
          spawnMap.set(row.session_id, (spawnMap.get(row.session_id) || 0) + 1);
        }
      }
    }
    // Convert tool maps to sorted arrays
    for (const [sid, tools] of toolMap) {
      const arr = [...tools.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => ({ name, count }));
      toolMap.set(sid, arr);
    }

    const result = sessions.map((s) => {
      const st = statsMap.get(s.id) || {};
      const tr = tailMap.get(s.id) || {};
      const firstContent = firstUserMap.get(s.id);
      const lastMessage = lastMessageMap.get(s.id) || null;
      const lastActivity = st.last_ts ? unixToIso(st.last_ts) : unixToIso(s.ended_at);
      const tail = {
        endedAt: unixToIso(s.ended_at),
        lastAssistantAt: unixToIso(tr.last_assistant_ts),
        lastPromptAt: unixToIso(tr.last_prompt_ts),
        endTurnAt: null,
        pendingToolAt: pendingMap.get(s.id) || null,
      };

      return {
        id: s.id,
        timestamp: unixToIso(s.started_at),
        lastActivity,
        messageCount: s.message_count || 0,
        userCount: st.user_count || 0,
        assistantCount: st.assistant_count || 0,
        toolCallCount: s.tool_call_count || 0,
        toolResultCount: st.tool_result_count || 0,
        topTools: toolMap.get(s.id) || [],
        spawnCount: spawnMap.get(s.id) || 0,
        firstUserMessage: firstContent ? firstContent.trim() : null,
        lastMessage,
        model: s.model || null,
        source: s.source || null,
        title: s.title || null,
        inputTokens: s.input_tokens || 0,
        outputTokens: s.output_tokens || 0,
        estimatedCost: s.estimated_cost_usd || null,
        parentSessionId: s.parent_session_id || null,
        tail,
        mtimeMs: null,
        file: 'state.db',
      };
    });

    // 按状态分组，组内按 lastActivity 降序（与既有排序语义一致）
    return sortSessionsByStatusGroups(result, { nowMs: Date.now(), sortBy: 'lastActivity' });
  } finally {
    db.close();
  }
}

function getHermesSession(dir, sessionId) {
  const db = openHermesDb(dir);
  if (!db) return null;
  try {
    const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!s) return null;

    const rows = db
      .prepare(`
      SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC
    `)
      .all(sessionId);

    const messages = [];
    for (const row of rows) {
      const msg = normalizeHermesMessage(row);
      if (msg) messages.push(msg);
    }

    const session = {
      id: s.id,
      source: s.source,
      model: s.model,
      title: s.title,
      cwd: null,
      timestamp: unixToIso(s.started_at),
      inputTokens: s.input_tokens || 0,
      outputTokens: s.output_tokens || 0,
      cacheReadTokens: s.cache_read_tokens || 0,
      cacheWriteTokens: s.cache_write_tokens || 0,
      reasoningTokens: s.reasoning_tokens || 0,
      estimatedCost: s.estimated_cost_usd || null,
      actualCost: s.actual_cost_usd || null,
      parentSessionId: s.parent_session_id || null,
    };

    return { session, messages };
  } finally {
    db.close();
  }
}

function normalizeHermesMessage(row) {
  const role = row.role;
  const content = row.content || '';
  let toolCalls = null;
  if (row.tool_calls) {
    try {
      toolCalls = JSON.parse(row.tool_calls);
    } catch {
      toolCalls = null;
    }
  }
  // Hermes messages carry an extra `reasoning` field on top of the shared shape
  const base = { id: String(row.id), timestamp: unixToIso(row.timestamp), reasoning: null };

  if (role === 'user') {
    return makeMessage({ ...base, role: 'user', content: [{ type: 'text', text: content }] });
  }

  if (role === 'assistant') {
    const unifiedContent = [];
    if (content) {
      unifiedContent.push({ type: 'text', text: content });
    }
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        unifiedContent.push({
          type: 'toolCall',
          id: tc.id || null,
          name: tc.function?.name || tc.name || 'unknown',
          arguments: (() => {
            const raw = tc.function?.arguments || tc.arguments || '{}';
            if (typeof raw === 'string') {
              try {
                return JSON.parse(raw);
              } catch {
                return { _raw: raw };
              }
            }
            return raw;
          })(),
        });
      }
    }
    return makeMessage({
      ...base,
      role: 'assistant',
      content: unifiedContent,
      usage: row.token_count ? { total_tokens: row.token_count } : null,
      reasoning: row.reasoning || null,
    });
  }

  if (role === 'tool') {
    return makeMessage({
      ...base,
      role: 'toolResult',
      content: [{ type: 'text', text: content }],
      toolCallId: row.tool_call_id || null,
      toolName: row.tool_name || null,
    });
  }

  // system or other roles
  if (content) {
    return makeMessage({ ...base, role: role || 'system', content: [{ type: 'text', text: content }] });
  }

  return null;
}

function searchHermesSessions(dir, query, maxResults) {
  const db = openHermesDb(dir);
  if (!db) return [];
  try {
    // Use FTS5 if available, otherwise fall back to LIKE
    let rows;
    try {
      rows = db
        .prepare(`
        SELECT m.session_id, m.role, m.content, m.timestamp
        FROM messages_fts fts
        JOIN messages m ON m.id = fts.rowid
        WHERE messages_fts MATCH ?
        LIMIT ?
      `)
        .all(query, maxResults * 3);
    } catch {
      const likeQ = `%${query}%`;
      rows = db
        .prepare(`
        SELECT session_id, role, content, timestamp
        FROM messages
        WHERE content LIKE ?
        LIMIT ?
      `)
        .all(likeQ, maxResults * 3);
    }

    // Group by session
    const bySession = new Map();
    for (const row of rows) {
      if (!bySession.has(row.session_id)) bySession.set(row.session_id, []);
      const matches = bySession.get(row.session_id);
      if (matches.length < 3) {
        const text = row.content || '';
        const idx = text.toLowerCase().indexOf(query.toLowerCase());
        const start = Math.max(0, idx - 40);
        const end = Math.min(text.length, idx + query.length + 60);
        const snippet = (start > 0 ? '\u2026' : '') + text.slice(start, end) + (end < text.length ? '\u2026' : '');
        matches.push({ role: row.role, snippet, timestamp: unixToIso(row.timestamp) });
      }
    }

    const results = [];
    for (const [sessionId, matches] of bySession) {
      if (results.length >= maxResults) break;
      results.push({ sessionId, file: 'state.db', platform: 'hermes', matches });
    }
    return results;
  } finally {
    db.close();
  }
}

module.exports = {
  getHermesDbPath,
  openHermesDb,
  openHermesDbForWatch,
  unixToIso,
  listHermesSessions,
  getHermesSession,
  normalizeHermesMessage,
  searchHermesSessions,
};
