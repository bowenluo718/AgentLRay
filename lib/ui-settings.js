'use strict';
// 页面（web 看板）持久化的 UI 偏好 —— 平台选择的服务端落盘与读取。
//
// ui section 承载两个角色：
//   - platform：设置面板「默认平台」独占管理（单选）；CLI（bin/sessions.js）
//     在未传 --platform 时读取作 show/resume 的缺省平台，list 在多选为空时兜底。
//   - selectedPlatforms：侧栏会话筛选的多选集合，由前端 persistState 同步。
// 二者经 saveUiSettings 部分更新互不覆盖。所有设置聚合存 ~/.agentlray/settings.json。
const { readSettings, saveSections } = require('./settings');

// 读取页面持久化的平台选择；未配置 → null（CLI 据此回退：list = all，
// show/resume = 报错要求显式 --platform）。
async function loadUiSettings() {
  const data = await readSettings();
  const ui = data.ui;
  if (!ui || typeof ui !== 'object' || Array.isArray(ui)) return null;
  return {
    platform: typeof ui.platform === 'string' ? ui.platform : null,
    selectedPlatforms: Array.isArray(ui.selectedPlatforms) ? ui.selectedPlatforms : [],
  };
}

// 部分更新：platform / selectedPlatforms 均可选（undefined = 不改该键）。
// 两条写路径互不干扰：设置面板「默认平台」只写 platform；前端侧栏 persistState
// 只写 selectedPlatforms。任一方都不覆盖另一方已保存的值。
async function saveUiSettings({ platform, selectedPlatforms }) {
  const data = await readSettings();
  const current = data.ui && typeof data.ui === 'object' && !Array.isArray(data.ui) ? data.ui : {};
  // 浅合并而非整体替换：平台选择只覆盖自己涉及的键，保留 ui section 中可能存在的
  // 其他偏好（历史版本/其他入口写入的目录等）。
  const next = { ...current };
  if (platform !== undefined) next.platform = platform;
  if (selectedPlatforms !== undefined) next.selectedPlatforms = selectedPlatforms;
  await saveSections({ ui: next });
  return next;
}

module.exports = { loadUiSettings, saveUiSettings };
