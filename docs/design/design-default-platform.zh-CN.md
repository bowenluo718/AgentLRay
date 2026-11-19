# 设置面板「默认平台」+ 移除两个一次性迁移

> 类型：方案设计 · 更新：2026-11-10 · 状态：已实施

## 问题

web 设置弹框「平台」面板缺少「默认平台」设置。此前 `ui.platform`（`~/.agentlray/settings.json` 的 `ui` section）只是侧栏当前选中平台的镜像——前端 `persistState()` 无条件把 `st.platform` 写回服务端，`ui.platform` 随侧栏点击漂移，无法作为稳定的「默认平台」供 CLI 缺省使用。

## 决策

1. **复用现有 `ui.platform` 作为「默认平台」**，不新增字段。
2. **移除侧边栏对 `ui.platform` 的覆盖**：`persistState()` 只写 `selectedPlatforms`；`ui.platform` 改由设置面板独占管理，作为稳定默认平台。CLI（`bin/sessions.js` `resolveDefaultPlatform`）继续读它：show/resume 缺省用 `ui.platform`，list 优先 `selectedPlatforms` 否则用 `ui.platform`。
3. **`saveUiSettings` 改为部分更新**（platform / selectedPlatforms 均可选，undefined = 不改）：设置面板只写 `platform`，侧栏 persistState 只写 `selectedPlatforms`，两条写路径互不覆盖。`lib/routes/settings.js` PUT ui 分支同步改为「仅当字段存在时处理」。
4. **UI**：设置面板平台面板顶部新增「默认平台」单选（复用 Checkbox 模拟互斥，零依赖）；可选项 = 已挂载 + 非 broken 平台；停用当前默认平台时自动转移到第一个已挂载非 broken 平台（与后端 `defaultPlatformId()` catalog 序语义一致）；选中平台卡片头部显示「默认」徽标。
5. **移除两个一次性迁移**（已无旧版存量可迁）：
   - 前端 Q13 目录迁移：`useDirsMigration.ts`、`readLegacyDirsFromLocalStorage`/`clearLegacyDirsFromLocalStorage`/`LEGACY_DIR_KEYS`、App.tsx 调用。
   - 服务端旧文件迁移：`lib/settings.js` 的 `migrateLegacySettings`/`LEGACY_SECTION_BY_FILE`、server.js 与 bin/sessions.js 调用。

## 边界与取舍

- **「必须且只能一个默认平台」**：单选天然保证。服务端校验保持现状白名单（`ALL_PLATFORMS` 含 disabled），不新增「必须已挂载」校验——停用默认平台后 CLI 已有合理回退（list 走 all；show/resume 报「当前未挂载/Unknown platform」，要求显式 `--platform`）。
- **后端 `defaultPlatformId()` 不改**：保持「第一个已挂载平台」语义；设置面板默认平台只写 `ui.platform`（CLI 缺省），两者并存不冲突。
- **现有旧值保留**：已存在的 `ui.platform`（旧 persistState 写入的侧栏平台镜像）继续当默认平台展示，用户可改。
- **demo 模式**：不受影响（persistState 跳过服务端同步、设置面板空态正常）。

## 验证

- `test/settings.test.js`：`saveUiSettings` 部分更新（只写 platform 不改 selectedPlatforms，反之亦然，空 patch 不改任何键）；删除迁移用例。
- `test/api.test.js`：PUT ui 部分更新（只写 platform 保留多选、只写 selectedPlatforms 保留默认平台且不清 null、未知平台 400、非数组 selectedPlatforms 400）。
- `test/session-cli.test.js`：删除 CLI 入口迁移用例；缺省平台用例保留（直接写 settings.json ui section）。
- 前端 `npm run build`（tsc -b && vite build）通过。
- 手工冒烟：设置面板默认平台单选 Save 后 `ui.platform` 更新且 `ui.selectedPlatforms` 未清空；侧栏切平台后重开设置 `ui.platform` 未变；`agentlray sessions list` 缺省按 selectedPlatforms、show/resume 缺省用 `ui.platform`；停用默认平台自动转移。

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：已实施**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| `ui.platform` 作默认平台单选 | ✅ 已实现 | `lib/ui-settings.js`、`frontend/src/store.ts` |
| 侧栏只写 `selectedPlatforms` | ✅ 已实现 | `frontend/src/store.ts` |
| 移除两个一次性迁移 | ✅ 已实现 | 代码中无 `migrateLegacySettings` / `LEGACY_DIR_KEYS` |

> 本文档已从 `docs/.local/` 迁移至正式文档目录，随代码提交；`docs/.local/` 保留同名过程稿。后续实现变更请同步更新本节与 `docs/.local/README.md` 的进度索引。
