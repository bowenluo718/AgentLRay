'use strict';
// 全局测试隔离（package.json test 脚本经 `node --require ./test/setup-env.cjs`
// 注入）：为所有测试提供空的平台来源目录（project/ 与 user/），确保 require
// lib/platforms 时不会并入用户本机真实的自定义适配器与禁用/替代配置，保证
// 「空配置基线 → 7 个内置平台」的确定性基线。
//
// 注意：此处【不得】设置 AGENTLRAY_HOME 或全局改 HOME。lib/config 用
// `process.env.AGENTLRAY_HOME || os.homedir()` 解析 HOME，既有测试在使用
// lib/platforms 等模块前会自行 `process.env.HOME = tmpHome` 重建隔离家目录
//（含 ~/.agentlray/settings.json）；这里若抢先钉死 AGENTLRAY_HOME 会破坏它们。
// 同理，平台目录只在此处「未设置时」注入默认空目录，测试内自行覆盖优先。
const fs = require('fs');
const os = require('os');
const path = require('path');

function newEmptyTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

if (process.env.AGENTLRAY_PLATFORMS_DIR === undefined) {
  process.env.AGENTLRAY_PLATFORMS_DIR = newEmptyTmpDir('agentlray-empty-user-platforms-');
}
if (process.env.AGENTLRAY_PROJECT_PLATFORMS_DIR === undefined) {
  process.env.AGENTLRAY_PROJECT_PLATFORMS_DIR = newEmptyTmpDir('agentlray-empty-project-platforms-');
}
