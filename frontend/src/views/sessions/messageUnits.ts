// Turn grouping + retry-chain analysis for the message list — ported from
// legacy renderMessages/buildRetryChains (public/js/app.js).

import type { MessageContentPart, SessionMessage } from '@/api/types';

export interface TurnUnit {
  type: 'turn';
  assistant: SessionMessage;
  /** OpenClaw: embedded toolCall parts; Codex/OMP: standalone toolCall records */
  tools: (MessageContentPart | SessionMessage)[];
  steps: SessionMessage[];
}

export type MessageUnit = { type: 'single'; msg: SessionMessage } | TurnUnit;

/**
 * 以 user 消息为边界的外层分组：把「一条 user 输入 + 其后续整个回复回合（assistant
 * 文本/工具调用，直到下一条 user 前）」打包为一个可折叠模块。时间正序输入。
 * - 首个块若无 user 头（会话起始的孤儿 toolResult / reasoning 等），user 为 null，不可折叠。
 * - 其余每块以一条 user 消息开头，items 为其引发的回复单元。
 */
export interface UserBlock {
  type: 'block';
  user: SessionMessage | null;
  items: MessageUnit[];
}

export function buildUserBlocks(units: MessageUnit[]): UserBlock[] {
  const blocks: UserBlock[] = [];
  let current: UserBlock = { type: 'block', user: null, items: [] };
  for (const unit of units) {
    if (unit.type === 'single' && unit.msg.role === 'user') {
      if (current.user !== null || current.items.length > 0) {
        blocks.push(current);
      }
      current = { type: 'block', user: unit.msg, items: [] };
    } else {
      current.items.push(unit);
    }
  }
  if (current.user !== null || current.items.length > 0) {
    blocks.push(current);
  }
  return blocks;
}

// Group messages into display units:
// - user / reasoning messages: standalone
// - assistant with text only: standalone
// - assistant with tools + subsequent toolResults: collapsible group
// - For Codex/OMP: toolCall is a separate role, so assistant -> toolCall* -> toolResult*
export function buildMessageUnits(filtered: SessionMessage[], isCodex: boolean): MessageUnit[] {
  const units: MessageUnit[] = [];
  let i = 0;
  while (i < filtered.length) {
    const msg = filtered[i];

    if (msg.role === 'user' || msg.role === 'reasoning') {
      units.push({ type: 'single', msg });
      i++;
      continue;
    }

    if (msg.role === 'assistant') {
      const tools = (msg.content || []).filter((c) => c.type === 'toolCall');

      if (tools.length === 0 && !isCodex) {
        units.push({ type: 'single', msg });
        i++;
        continue;
      }

      // Codex-style: assistant text message, then collect subsequent toolCall/toolResult records
      if (isCodex && tools.length === 0) {
        const codexTools: SessionMessage[] = [];
        const codexResults: SessionMessage[] = [];
        let peek = i + 1;
        while (peek < filtered.length) {
          const next = filtered[peek];
          if (next.role === 'toolCall') {
            codexTools.push(next);
            codexResults.push(next); // include in steps
            peek++;
          } else if (next.role === 'toolResult') {
            codexResults.push(next);
            peek++;
          } else if (next.role === 'reasoning') {
            // reasoning between assistant and tools, skip
            peek++;
          } else {
            break;
          }
        }

        if (codexTools.length > 0) {
          units.push({ type: 'turn', assistant: msg, tools: codexTools, steps: codexResults });
          i = peek;
          continue;
        }

        units.push({ type: 'single', msg });
        i++;
        continue;
      }

      // OpenClaw-style: assistant with embedded toolCalls
      if (tools.length === 0) {
        units.push({ type: 'single', msg });
        i++;
        continue;
      }

      const group: TurnUnit = { type: 'turn', assistant: msg, tools: [...tools], steps: [] };
      i++;
      while (i < filtered.length) {
        const next = filtered[i];
        if (next.role === 'toolResult') {
          group.steps.push(next);
          i++;
        } else if (next.role === 'assistant') {
          const nextTools = (next.content || []).filter((c) => c.type === 'toolCall');
          const nextText = (next.content || []).filter((c) => c.type === 'text' && (c.text || '').trim());
          if (nextTools.length > 0) {
            group.steps.push(next);
            group.tools.push(...nextTools);
            i++;
          } else if (nextText.length === 0) {
            i++;
          } else {
            break;
          }
        } else {
          break;
        }
      }
      units.push(group);
      continue;
    }

    // Standalone toolCall sequence (no preceding assistant text), e.g. a tool
    // invoked right after a user turn. Aggregate the toolCall(s) and their
    // following toolResult(s) into a collapsible turn group, mirroring the
    // assistant-anchored one; the first toolCall anchors the row/graph lane.
    if (msg.role === 'toolCall') {
      const group: TurnUnit = { type: 'turn', assistant: msg, tools: [msg], steps: [msg] };
      i++;
      while (i < filtered.length) {
        const next = filtered[i];
        if (next.role === 'toolCall') {
          group.tools.push(next);
          group.steps.push(next);
          i++;
        } else if (next.role === 'toolResult') {
          group.steps.push(next);
          i++;
        } else {
          break;
        }
      }
      units.push(group);
      continue;
    }

    // Orphan toolResult / toolCall (no preceding assistant)
    units.push({ type: 'single', msg });
    i++;
  }
  return units;
}

// status: 'error-retried' | 'error-final' | 'success-recovered' | 'success-first'
export interface RetryInfo {
  status: 'error-retried' | 'error-final' | 'success-recovered' | 'success-first';
  attempt: number;
  totalAttempts: number;
  toolName: string;
}

// A retry = same toolName appears multiple times among a turn's toolResults.
export function buildRetryChains(unit: TurnUnit): { retryCount: number; retryMap: Map<SessionMessage, RetryInfo> } {
  const byName = new Map<string, { msg: SessionMessage; isError: boolean }[]>();

  unit.steps.forEach((step) => {
    if (step.role !== 'toolResult') return;
    const name = step.toolName || (step.name as string | undefined) || '?';
    const list = byName.get(name) || [];
    list.push({ msg: step, isError: step.isError });
    byName.set(name, list);
  });

  const retryMap = new Map<SessionMessage, RetryInfo>();
  let retryCount = 0;

  for (const [toolName, attempts] of byName) {
    if (attempts.length < 2) {
      const a = attempts[0];
      retryMap.set(a.msg, {
        status: a.isError ? 'error-final' : 'success-first',
        attempt: 1,
        totalAttempts: 1,
        toolName,
      });
      continue;
    }

    const hasAnyError = attempts.some((a) => a.isError);
    if (hasAnyError) retryCount++;

    attempts.forEach((a, i) => {
      const isLast = i === attempts.length - 1;
      let status: RetryInfo['status'];
      if (a.isError) {
        status = 'error-retried'; // error, and there's a next attempt
      } else if (!isLast) {
        status = 'success-first'; // success but more calls follow (parallel calls, not retry)
      } else {
        status = hasAnyError ? 'success-recovered' : 'success-first';
      }
      retryMap.set(a.msg, { status, attempt: i + 1, totalAttempts: attempts.length, toolName });
    });
  }

  return { retryCount, retryMap };
}
