# 主机设置布局与显示调整设计

> 状态：已实现（2026-11-14）。经 grill-me 两轮收敛，以下均按用户拍板落地。

## 背景与目标

原「主机」管理散落在两处：系统设置弹框（`SettingsDialog` 的 `hosts` 面板）与顶栏主机选择器（`HostSelector` 下拉 + inbound 徽标）。本次把主机相关入口、布局与显示统一调整：

1. 入口从系统设置弹框迁到**左侧栏底部固定**；本地时显示「远程连接」，否则显示当前连接主机名 + 右侧断开按钮。
2. 点击入口打开**独立主机设置弹框**（`HostsDialog`）。
3. 弹框内容调整（见下），远程主机项的「测试连接」按钮移除、「连接/断开」切换；添加/编辑表单迁入独立弹框。

## grill-me 决策收敛

| 决策点 | 拍板 |
| --- | --- |
| 3a「已连接主机显示迁移替换恒连接」 | inbound 徽标从顶栏迁到 `HostsDialog` 的 local 行，替换「恒连接」文本；顶栏不再显示该徽标 |
| 连接模型 | **单连接**：任意时刻最多一个远端已连接 = 当前选中主机；列表里「当前选中且非 local」的主机显示断开，其余显示连接 |
| 切换方式 | 弹框内点「连接」即 `setSelectedHostId`（同顶栏切换逻辑）；顶栏右上角下拉**移除** |
| inbound 徽标 | 迁入主机弹框（`HostsDialog` local 行），保留悬浮连接详情 + 点击查看明细逻辑 |
| 必填字段 | `host` 恒必填；新建时 `id` 必填 |
| 「断开前校验」 | 用户澄清为笔误——实际是**测试连接与保存**都先校验必填 |
| 侧栏入口固定 | 始终固定可见（贴侧栏容器底部） |
| 连接失败 | toast 报错、停留原主机（同现有顶栏切换逻辑） |

## 实现

### 后端

- `lib/hosts.js`：`openHost` 重构出核心 `tunnelAndProbe(id, ssh, skipReporting)`，供 `openHost` 与新增 `testHostSpec(input)` 共用——避免表单「测试连接」复制隧道逻辑。`testHostSpec` 用合成 id（`__probe__<id>`）隔离，`skipReporting` 跳过入站上报，测完即关，不持久化、不影响当前选中主机。
- `lib/routes/hosts.js`：新增 `POST /api/hosts/test`（body = 主机规格，校验失败 400，探测失败返回 `{ok:false,status,error}`）。
- `lib/hosts.js` 新增 `getSelfIdentity()`；`lib/routes/inbound.js` 的 `GET /api/inbound` 响应加 `self`（本机自报身份，供 local 行展示「上报的主机名」）。

### 前端

- `HostFormDialog.tsx`（新）：新建/编辑表单独立弹框，默认隐藏；底部三按钮 **取消 / 测试连接 / 保存**；必填校验（host + 新建时 id，红框 + 提示），测试连接与保存都先校验必填。测试连接走新 `POST /api/hosts/test`（`client.testHostSpec`）。
- `HostsDialog.tsx`（新）：主机设置弹框。local 行说明改「本机 · <上报主机名>」、右侧 inbound 徽标替换「恒连接」；远程行「连接/断开」切换（连接 = `setSelectedHostId` 成功后整页刷新，断开 = `disconnectHost`），移除「测试连接」按钮；「添加主机」按钮 + 每行「编辑」打开 `HostFormDialog`。
- `Sidebar.tsx`：底部固定主机入口（给定显示器 SVG 图标 + 当前主机名/「远程连接」+ 非本地时右侧断开按钮），点击打开 `HostsDialog`。
- `SettingsDialog.tsx`：移除 `hosts` 面板（menu/type/draft 清理）。
- `App.tsx` / 删除 `HostSelector.tsx` / `HostsTab.tsx`：顶栏主机下拉与 inbound 徽标移除（能力迁入 `HostsDialog` 与 `Sidebar`），相关组件删除。
- `client.ts` 新增 `testHostSpec`；`types.ts` `InboundInfo` 加 `self`；`demo/router.ts` 的 inbound mock 补 `self`。

## 追加细化（2026-11-16）

- **入口常驻**：侧栏底部主机入口以 `mt-auto`（flex-col 下自动上边距吸收剩余空间）固定贴底，**不依赖** `SessionList` 的 `flex-1`——即使 `SessionList` 完全不挂载（技术会话列表空/未渲染），入口也始终固定在侧栏底部展示。
- **入口 inbound 数量徽标**：仅当前是本地（显示「远程连接」）时，在入口右侧显示非交互的 inbound 数量徽标（`被 N 连` 圆形小徽标，仅信息展示、**不可点击、无详情**）。HostsDialog local 行的 inbound 徽标**保留**悬浮详情 + 点击查看明细逻辑不变。

## 追加：主机「当前选中」真实变更后统一收尾（2026-11-16，评审修复）

主机连接**真实变更**（连接 / 断开 / 编辑当前选中 / 删除当前选中）后，统一处理逻辑：
**更新记忆缓存（localStorage `REMEMBERED_HOST_KEY`）→ 清 URL 查询参数 → 回「会话」主页 → 整页刷新**，重拉本机数据面。抽成共享函数 `settleHostSwitch()`（`HostsDialog.tsx`），替换连接/断开处原本重复的三行收尾。

- **连接**：`setSelectedHostId` 成功 → `settleHostSwitch()`。
- **断开当前选中**：`disconnectHost` 成功后（store 内部已切回 local + 更新记忆缓存）→ `settleHostSwitch()`。
- **编辑当前选中**（评审问题 2 修复）：后端 `updateHost` 已 `closeHost` 断隧道；前端 `HostFormDialog` 保存成功后按新配置重连（`setSelectedHostId` 更新记忆缓存）→ `settleHostSwitch()`。
- **删除当前选中**（评审问题 2 修复）：后端 `deleteHost` 已断隧道；前端 `HostsDialog` 删除成功后把记忆缓存写回 `local`、`setSelectedHostId('local')` → `settleHostSwitch()`。
- 非当前选中的主机编辑/删除只 `invalidate()`，不刷新页面（不涉及当前数据面）。

配套：`client.ts` 移除死代码 `testHost` 导出（服务端 `POST /api/hosts/:id/test` 路由保留向后兼容）；`lib/transport.js` 的 `spawnSsh` 新增 `AGENTLRAY_SSH_BIN` 环境变量注入点（对齐 `AGENTLRAY_*_BIN` 模式，供测试 mock）；新增 `test/fixtures/ssh-mock.cjs`（mock ssh 隧道转发）。

## 验证（追加评审修复后）

- `npm test`：676/676 通过（新增：`testHostSpec` 成功路径——探测到 version、`__probe__` 不残留运行时、不落盘、`skipReporting` 不上报；`updateHost`/`deleteHost` 当前已连接先关隧道；inbound `self`）。
- `frontend npm run build`：通过。
- 冒烟：启动 server，`GET /api/inbound` 返回 `self`；`POST /api/hosts/test` 缺 `ssh.host` → 400「ssh.host 必填」，合法但不可达 → `{ok:false,status:'error',error:'Connection refused'}`。

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：已实现**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| 侧栏底部主机入口 + `HostsDialog` | ✅ 已实现 | `frontend/src/components/{Sidebar,HostsDialog}.tsx` |
| `HostFormDialog` + 未保存测试连接 | ✅ 已实现 | `frontend/src/components/HostFormDialog.tsx`、`lib/routes/hosts.js:99` |
| inbound 徽标/`self` | ✅ 已实现 | `lib/inbound.js`、`frontend/src/components/HostsDialog.tsx` |

> 本文档已从 `docs/.local/` 迁移至正式文档目录，随代码提交；`docs/.local/` 保留同名过程稿。后续实现变更请同步更新本节与 `docs/.local/README.md` 的进度索引。
