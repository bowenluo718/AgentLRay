'use strict';
// @agentlray/shared 裸名 require 别名（Q9=A / Q10=A / Q17=A / Q18=A）。
//
// 把平台代码里的 `require('@agentlray/shared/<sub>')` 解析到
// `<packageRoot>/lib/platforms/shared/<sub>`。内置平台（builtin/<id>/）与
// 自定义/项目平台（platforms/<id>/）统一用该裸名引用外层共享，迁移到自定义
// 平台目录后不依赖原 lib/ 位置（开箱即用）。
//
// 用 Node 的 Module._resolveFilename 全局钩子实现；lib/platforms/index.js 在
// require 任何 builtin 之前调用 installSharedAlias() 注册。命中 @agentlray/shared
// 前缀时改写为 shared 目录绝对路径；否则原样交给 Node 默认解析。
const path = require('path');
const Module = require('module');

const SHARED_DIR = path.resolve(__dirname, 'shared');
const PREFIX = '@agentlray/shared';

function installSharedAlias() {
  const defaultResolve = Module._resolveFilename;
  // 幂等：重复安装不叠加钩子。
  if (Module._resolveFilename.__agentlraySharedAlias) return;
  Module._resolveFilename = function (request, ...rest) {
    if (typeof request === 'string' && request.startsWith(PREFIX)) {
      const sub = request.slice(PREFIX.length).replace(/^\/+/, '');
      const target = path.join(SHARED_DIR, sub || 'index');
      return defaultResolve.call(this, target, ...rest);
    }
    return defaultResolve.call(this, request, ...rest);
  };
  Module._resolveFilename.__agentlraySharedAlias = true;
}

module.exports = { installSharedAlias, SHARED_DIR };
