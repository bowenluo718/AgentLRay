# 项目平台目录（`platforms/`）

本目录用于存放**随仓库 / 随包分发**的项目平台适配器（来源 `project`）。平台适配器会以你的用户权限执行其任意代码，随包分发扩大了信任边界——**只投递可信的适配器文件**。

## 信任边界

- 平台适配器是 CommonJS 单文件，`module.exports` 导出适配器对象（契约见 [docs/.local/guide-custom-platforms.zh-CN.md](../docs/.local/guide-custom-platforms.zh-CN.md)）。
- 加载后会以当前进程权限执行其任意代码（`require` 即执行）。
- 不需要项目平台的场景可用 `AGENTLRAY_NO_PLUGINS=1` 跳过本目录与用户目录的加载（`platform list` 会显示逃生说明）。
- `platform list` 会为项目平台标注来源 `Project`。

## 文件格式

每个文件是一个平台适配器（与用户目录 `~/.agentlray/platforms/*.js` 相同的契约）：

```js
'use strict';
module.exports = {
  id: 'my-platform',
  label: 'My Platform',
  defaultDir: () => '/path/to/sessions',
  list: async (dir) => [ /* SessionSummary[] 最新在前 */ ],
  // parse / getSession / 可选能力 hook（见自定义平台指导文档）
};
```

## manifest.json（可选）

`platforms/manifest.json` 可含一个可选的 `replaces` 数组，表达「本项目有意替换包内置平台」：

```json
{
  "replaces": ["codex"]
}
```

- 加载时会把 `manifest.replaces` 与用户设置 `~/.agentlray/settings.json` 的 `platforms.replaced` **取并集**作为生效的替代声明集合。
- 声明了替代（且存在同 id 适配器）→ 该适配器覆盖包内置，来源为 `Project`。
- 声明了替代但同 id 适配器缺失/损坏 → 回退到包内置（`replacementPending: true`）。
- 未声明替代的同 id 项目文件 → 标记 broken（不静默顶包内置）。

本仓库 `manifest.json` 默认为 `{"replaces": []}`（无替代声明）。
