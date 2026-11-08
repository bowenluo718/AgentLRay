'use strict';
// 全局测试隔离（package.json test 脚本经 `node --require ./test/setup-env.cjs`
// 注入）：为所有测试提供空的用户平台来源目录（user/），确保 require
// lib/platforms 时不会并入用户本机真实的自定义适配器与禁用/替代配置，保证
// 「空配置基线 → 4 内置平台 + 仓库 platforms/ 项目平台」的确定性基线。
//
// 同时注册 @agentlray/shared 裸名别名：dsh/gemini/hermes 已迁移为项目平台
//（platforms/<id>/），其代码经 `@agentlray/shared/<sub>` 裸名引用共享层，直接
// require 项目平台（不经 lib/platforms/index.js）的测试依赖该别名提前就绪。
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

// 项目来源保留仓库自带 platforms/（dsh/gemini/hermes 随包分发、确定性），
// 仅当测试显式覆盖时才改变。
if (process.env.AGENTLRAY_PROJECT_PLATFORMS_DIR === undefined) {
  delete process.env.AGENTLRAY_PROJECT_PLATFORMS_DIR;
}

// 注册 @agentlray/shared 裸名别名，幂等。
require('../lib/platforms/shared-alias').installSharedAlias();
