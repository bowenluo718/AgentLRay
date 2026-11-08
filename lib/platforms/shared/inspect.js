'use strict';
// inspect 通用实现（原 inspect-impl.js 的通用部分）。
//  - noToolEntries —— 无工具条目回退
// 平台专属的 normalizers / rawToolEntriesByPlatform 映射与各平台 rawToolEntries 实现
// 内聚进各 builtin/<id>/inspect.js，由编排层 lib/inspect.js 从适配器 inspect hook 组装
// （本文件不反向 require 平台，避免 shared → builtin 层次反转）。
const noToolEntries = () => ({ calls: [], results: [] });

module.exports = {
  noToolEntries,
};
