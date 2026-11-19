# 远端主机手动退出连接（disconnect）设计

> 状态：**已实现**。多主机 P0（`d005166` 起）支持经 ssh 隧道连接远端 AgentLRay，但缺少手动断开连接的入口。本文档记录该能力的设计与实现。
> 关联：[design-multi-host.zh-CN.md](design-multi-host.zh-CN.md)（多主机总设计）、`design-multi-host-tunnel-pool.zh-CN.md`（未随仓库分发）（隧道池，预留 disconnect 概念，未实现）。

## 1. 需求一句话

**远程主机连接后支持手动退出连接**：关闭隧道 + 停心跳 + 清运行时，不影响主机配置（不删除主机）。

已与用户确认的决策：

1. **断开当前查看的远端 → 自动切回本机**（local）。避免停留在 disconnected 导致数据面 503/空白。断开非当前主机 → 只关隧道，不影响当前视图。
2. **入口两处**：设置面板「主机」tab 每台远端的「断开」按钮 + 顶栏独立「断开」按钮（当前选中远端且已连时显示）。

## 2. 现状

| 文件 | 现状 |
| --- | --- |
| `lib/hosts.js` | `closeHost(id)`（:273）已实现：`stopReporting`（停心跳）+ kill ssh 子进程 + 清 runtime。`LOCAL_ID` 恒 connected。 |
| `lib/routes/hosts.js` | 挂载 `/api/hosts` 路由，有 `connect`/`test`/CRUD。**缺 `disconnect` 端点**。 |
| `lib/routes/proxy.js` | `WRITE_RESOURCE_RE`（:20-26）含 `^/api/hosts(/|$)` → `/api/hosts*` 是本地网关资源，**不会**被远端透传。disconnect 端点天然只在本机处理。 |
| 前端 `client.ts` | 有 `getHosts`/`connectHost`/`testHost`，**缺 `disconnectHost`**。 |
| 前端 `store.ts` | `setSelectedHostId`（:611）切主机自动 `connectHost`；`REMEMBERED_HOST_KEY`（:131）记忆上次主机。 |
| 前端 `HostsTab.tsx` | 设置面板主机 tab，每台远端有测试/编辑/删除，**无断开**。 |
| 前端 `HostSelector.tsx` | 顶栏选择器，切换主机用。 |

当前是**单隧道模式**：`connectHost` 成功后服务端 `closeAllExcept(id)` 只留当前一条隧道（`lib/routes/hosts.js:117`）。disconnect 是在此模式下的主动断开（而非隧道池的断开某条常驻隧道）。

## 3. 接口契约

### POST /api/hosts/:id/disconnect

请求：无 body。

- `local` → `400 { error: '本机不可断开' }`（local 恒 connected）。
- 其他 id → `closeHost(id)` → `200 { id, status: 'disconnected' }`。
- **幂等**：`closeHost` 对不在 runtime 的 id 无副作用（`runtime.get` 为空直接返回）；hosts.json 里有没有该 id 都允许断开（closeHost 只动运行时，不做 getHost 校验）。
- proxy 黑名单已覆盖 `/api/hosts(/|$)`，带 `X-Host-Id`/`?host=` 指向远端时该端点走本地路由（返回 403 本地资源不透传），天然正确，无需改 proxy。

## 4. 实现

### 4.1 后端

`lib/routes/hosts.js` 在 `connect` 端点后新增：

```js
app.post('/api/hosts/:id/disconnect', (req, res) => {
  const id = req.params.id;
  if (id === LOCAL_ID) return res.status(400).json({ error: '本机不可断开' });
  closeHost(id);
  res.json({ id, status: 'disconnected' });
});
```

复用已导入的 `closeHost`（`lib/routes/hosts.js:12`）。

### 4.2 前端 client

`frontend/src/api/client.ts` 在 `connectHost` 旁新增（走 local 语义，同 `getHosts`/`connectHost`，强制本机网关资源）：

```ts
export function disconnectHost(id: string): Promise<{ id: string; status: string }> {
  return requestJson(`/api/hosts/${encodeURIComponent(id)}/disconnect`, 'POST', undefined, { local: true });
}
```

### 4.3 前端 store

`frontend/src/store.ts` 新增 `disconnectHost(id): Promise<boolean>` action：

1. 调 client `disconnectHost(id)`；失败返回 `false`（调用方 toast）。
2. 若 `id === selectedHostId`（断开的是当前查看的远端）→ `setSelectedHostId('local')`：内部连 local 恒成功、置 hostReady，并把 `REMEMBERED_HOST_KEY` 写回 local（无需手动清记忆键）。
3. 否则（断开非当前主机）→ 只 `setHostRuntime(id, 'disconnected', null)` 更新本地运行时状态。
4. 返回 `true`。

### 4.4 前端入口

**设置面板 `HostsTab.tsx`**：每台远端（`h.id !== 'local'`）按钮组在「测试连接」后加「断开」按钮：

- `disabled`：`h.status !== 'connected'` 或断开进行中（`disconnectMut.isPending && disconnectMut.variables === h.id`）。
- `title="关闭隧道并断开连接"`。
- `disconnectMut`（useMutation）：**走 store 的 `disconnectHost` action**（与顶栏逻辑一致），`onSuccess` → `invalidate()` 刷新 hosts 列表 + toast。这样断开「当前使用（selectedHostId）」的远端时同样自动切回本机。

**顶栏 `HostSelector.tsx`**：Select 旁、InboundBadge 前，条件渲染断开按钮：

- 仅当 `selectedHostId !== 'local' && curStatus === 'connected'` 时显示（`curStatus` 已在组件内 :90）。
- `onClick` 调 store `disconnectHost(selectedHostId)`；成功 toast `已断开连接`，失败 toast error。
- 断开自动切回本机（store 内逻辑），无需手动 reload（`setSelectedHostId('local')` 内部置 hostReady，组件树切回本机数据面）。

## 5. 边界与取舍

- **local 不可断**：local 恒 connected 直连本进程端口，无隧道可断；后端 400 + 前端两处入口均对 local 不显示/禁用。
- **断开的非当前主机**：只关隧道，当前视图（若正查看另一台）不受影响。
- **proxy 不透传**：disconnect 属主机本地资源（`WRITE_RESOURCE_RE`），带远端 host 头时 403，与 `/api/hosts` 其他写操作同口径。
- **与隧道池的关系**：本实现基于当前单隧道模式。若后续落地 `design-multi-host-tunnel-pool`（多隧道常驻），disconnect 端点可直接复用为「断开单条常驻隧道」，store action 的「断开当前查看 → 切回本机」语义在池化后需调整为「只断隧道、游标不强制回本机」——留待池化设计处理。

## 6. 验证

1. `test/hosts.test.js`：新增 `closeHost` 行为用例——注入 connected runtime（`setRuntimeForTest`）后 `closeHost` → `getRuntime(id) === undefined`；local 无副作用；不存在的 id 幂等不抛。
2. `test/proxy.test.js`：「主机管理（/api/hosts）远端 → 403」用例补 `POST /api/hosts/abc/disconnect` 403 断言。
3. `npm test` 全量（基线 671/671 不回退）。
4. `cd frontend && npm run build` TS 编译 + Vite 构建通过。
5. 手工 E2E：两个 AgentLRay 实例，A 配置 B 并切换连接 B → 顶栏出现「断开」按钮，点击后自动切回本机、B 状态 disconnected；设置面板主机 tab B 显示「断开」按钮（connected 时可用）；断开 local 无入口。

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：已实现**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| `POST /api/hosts/:id/disconnect` | ✅ 已实现 | `lib/routes/hosts.js:159` |
| 前端断开并切回本机 | ✅ 已实现 | `frontend/src/store.ts`、`frontend/src/components/HostsDialog.tsx` |
| local 不可断开 | ✅ 已实现 | `lib/routes/hosts.js` |

