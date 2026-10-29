'use strict';
// 任务看板配置：web 设置面板经 GET/PUT /api/settings 读写 ~/.agentlray/
// settings.json 的 kanban section，控制看板每列最多显示的会话条数（默认 20）。
// 纯配置存储，不注入任何运行时模块（截断全在前端客户端完成）。
const { readSettings, saveSections } = require('./settings');

// 白名单 key → 默认值（键即白名单）。
const KANBAN_DEFAULTS = {
  maxPerStatus: 20,
};

async function readKanbanSection() {
  const data = await readSettings();
  const section = data.kanban;
  return section && typeof section === 'object' && !Array.isArray(section) ? section : {};
}

// 白名单加载：非正整数剔除；缺失 → {}（回退默认）。
async function loadKanbanConfig() {
  const section = await readKanbanSection();
  const result = {};
  if (Number.isInteger(section.maxPerStatus) && section.maxPerStatus > 0) {
    result.maxPerStatus = section.maxPerStatus;
  }
  return result;
}

// 保存：白名单过滤，非法/空值清除该 key；合并写入 kanban section，并回读干净配置。
async function saveKanbanConfig(body) {
  const current = await readKanbanSection();
  const value = body && body.maxPerStatus;
  if (Number.isInteger(value) && value > 0) current.maxPerStatus = value;
  else delete current.maxPerStatus;
  await saveSections({ kanban: current });
  return loadKanbanConfig();
}

module.exports = {
  KANBAN_DEFAULTS,
  loadKanbanConfig,
  saveKanbanConfig,
};
