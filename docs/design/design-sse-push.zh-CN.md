# AgentLRay SSE 实时推送机制

> 类型：参考分析 · 本文档讲解 AgentLRay 的 SSE（Server-Sent Events）实时推送实现，基于当前主干代码（含平台来源统一 v2 与多主机改造）撰写。

## 一、是什么

SSE 是 AgentLRay 实现**会话实时尾随（live tail）**的机制：当某平台会话日志文件新增内容时，后端通过一个长连接 HTTP 响应把**归一化消息**和**即时会话状态**推送给前端，让正在查看的会话详情"实时生长"，同时让侧栏/看板的会话状态徽标不依赖 5s 轮询就能刷新。

它不是全量订阅广播——每个连接只尾随**一个**具体会话（`platform + sessionId + agent`），按需建立。

## 二、数据流全景

```mermaid
sequenceDiagram
    participant UI as React (useSessionSse)
    participant Route as routes/watch.js
    participant Core as platforms/shared/watch.js
    participant Adapter as platform.watchParse
    participant File as 会话日志 JSONL/zstd

    UI->>Route: GET /api/watch?platform=..&sessionId=..[&agent=..]
    Route->>Adapter: platform.find(dir, sessionId) 定位日志文件
    Route->>Core: watchFile(req,res,platform,filePath)

    Note over Core,File: 连接初始化
    Core->>File: readNewLines(0) 全量读一次
    Core->>Adapter: watchParse 归一化每条行
    Core->>Core: watchTail() 建立尾部证据基线
    Core->>UI: event: connected {messageCount}

    loop fs.watch 文件变更(80ms 防抖)
        File-->>Core: change 事件
        Core->>File: readNewLines(byteOffset) 增量读
        Core->>Adapter: watchParse 归一化
        Core->>Core: accumulateWatchTail + deriveStatus
        Core->>UI: event: newMessages {messages, session.status}
    end

    Note over Core,UI: 15s ping 保活; 客户端断开即清理
```

## 三、服务端三层

### 1. 路由层 `lib/routes/watch.js` —— 只有 SSE 管道

- 校验 `sessionId`（必填）、`agent`（仅 `needsAgent` 平台如 openclaw）、`platform` 是否在注册表。
- 经 `dirFor` + `platform.find` 定位日志文件；找不到返回 404。
- **两条路径**：
  - 平台声明 `watch` hook（如 hermes 的 WAL 监听）→ 直接委托 `platform.watch`。
  - 否则要求 `platform.watchParse`，缺位直接 400（自定义平台不做实时尾随，状态仍靠轮询）。
  - 通过后调通用 `watchFile`。

### 2. 核心层 `lib/platforms/shared/watch.js` —— 状态机 + 字节偏移尾随

**字节偏移增量读 `readNewLines`**：每次从上次的 `byteOffset` 读新字节，只推进到**最后一个完整行**（撕裂的尾行等下次 change 事件补齐）。`dsh` 的 zstd 日志按帧解压，撕裂帧留给下次。

**平台归一化 `parseWatchLines`**：每条原始 JSONL 经 `platform.watchParse` 变成统一消息，并收集 `sessionMeta`（最近会话记录）和 `ended`（声明式结束标记）。

**尾部证据状态机 `accumulateWatchTail`**：与列表端同一套四态口径。喂入归一化消息：

- `toolCall`/`reasoning`/`assistant` → `noteAssistant`（记"工作中"活动）；
- 含真实文本的 `user` → `notePrompt`（记"待输入"）；
- `toolResult` → `resolvePending`（工具调用闭环）；
- `ended` → `noteEnded` + `resolveAllPending`（清残留，防误判成"待输入"）。

**状态推导**：每次推送前用 `deriveStatus(finishTail(state), {lastActivity}, now)` 现算状态。`lastActivity` 取历史最大值单调不回退，避免跨批次时间倒挂把活跃会话误判成老化。

### 3. SSE 管道 `watchFile` + `sseInit`

- `sseInit` 设响应头：`text/event-stream`、`no-cache`、`keep-alive`、`X-Accel-Buffering: no`（禁 nginx 缓冲），`flushHeaders` 立即下发。
- 连接时全量读一次，`watchTail` 建基线，发 `connected {messageCount}`。
- `fs.watch` 监听文件 change，**80ms 防抖**合并连续写入，触发 `onFileChange` 增量读→归一化→累加→推导状态→`newMessages` 推送。
- **15s ping** 保活防代理超时。
- `req.on('close')` 清理 watcher、定时器、防抖 timer——客户端断连即释放。

推送的事件格式：

```
event: connected    data: {"messageCount": N}
event: newMessages  data: {"messages":[...归一化], "session":{..., "status":"working"}}
event: error        data: {"error":"..."}
```

**恒推 `session.status`**：即使无新消息（结束/闲置标记批次）也推送，让状态即时收敛，不依赖下个 5s 轮询。

## 四、前端消费 `frontend/src/views/sessions/useSessionSse.ts`

- `new EventSource(watchUrl(...))`。注意 **EventSource 无法带自定义头**，所以远端主机用 `?host=` query 指定路由目标（`watchUrl` 在 `api/client.ts`）。
- 开/关条件：非 DEMO、主机就绪、`autoRefresh` 开启、有 `sessionId`、且**不在查看子代理转录本**（`viewingChildAgent` 时抑制）。
- 事件处理：
  - `connected` → 状态 `live`；
  - `newMessages` → 把 `payload.messages` **append 进** `['session', platform, id]` 详情缓存；把 `payload.session.status` **merge 进**侧栏列表缓存 `['sessions', platform]` 和聚合列表 `['sessions','multi']`，实现状态徽标即时变，同时 `invalidateQueries` 重拉计数；
  - `error` → 状态 `error`（EventSource 会自动重连）。
- 清理：`es.close()` + 状态 `off`。

## 五、与 5s 轮询的关系

**互补而非替代**：SSE 提供**即时**的增量（新消息 + 状态徽标）；5s 轮询是**校准基线**（全量重拉，兜底 SSE 断连/漏推送的场景）。看板与侧栏共用同一份列表缓存，一次 SSE 合并两者都受益。

## 六、关键设计点小结

| 方面 | 做法 | 原因 |
| --- | --- | --- |
| 增量读取 | 字节偏移，只推进到完整行/完整 zstd 帧 | 撕裂尾行下次补齐，不丢不重 |
| 归一化 | 平台 `watchParse` hook | 与列表端共用一套统一消息口径 |
| 状态口径 | `deriveStatus` 与列表端同一套四态 | SSE 与轮询状态语义一致 |
| 状态即时收敛 | 无新消息也恒推 `session.status` | 结束/闲置不依赖下个轮询 |
| 保活 | 15s ping + `X-Accel-Buffering: no` | 防代理/nginx 缓冲与超时掐断 |
| 断连清理 | `req.on('close')` 关 watcher/timer | 无客户端不残留扫描 |
| 自定义平台 | 无 `watchParse` → 400 | 不能实时尾随就老实走轮询 |

## 七、涉及文件

- `lib/routes/watch.js` —— SSE 路由（管道 + 平台解析）
- `lib/platforms/shared/watch.js` —— 核心：`readNewLines`/`parseWatchLines`/`accumulateWatchTail`/`watchTail`/`latestMessageTimestamp`/`sseInit`/`watchFile`
- `lib/platforms/shared/tail-state.js` —— 尾部证据状态机（`createTailState`/`noteAssistant`/`notePrompt`/`addPending`/`resolvePending`/`finishTail`/`noteEnded`/`resolveAllPending`）
- `lib/status.js` —— 统一四态推导 `deriveStatus`（`awaiting-input`/`working`/`waiting`/`stopped`）
- 各平台 `watchParse`（如 `lib/platforms/{openclaw,codex,omp,...}.js`）
- `lib/platforms/hermes/watch.js` —— 非文件型平台（SQLite WAL）的专属 SSE 处理器
- 前端 `frontend/src/views/sessions/useSessionSse.ts`、`frontend/src/api/client.ts`（`watchUrl`）

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：参考分析，与当前实现一致**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| SSE 路由与增量读取 | ✅ 已实现 | `lib/routes/watch.js`、`lib/platforms/shared/watch.js` |
| 前端缓存合并 | ✅ 已实现 | `frontend/src/views/sessions/useSessionSse.ts` |

