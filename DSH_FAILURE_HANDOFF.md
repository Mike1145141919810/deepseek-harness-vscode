# DeepSeek Harness 卡死故障交接报告

更新日期：2026-09-05（Asia/Shanghai）  
项目目录：`D:\michael_codes\dsh-vscode`  
当前结论：**已定位根因并修复（见第 13 节）。根因在扩展自带的 dsh-vscode-bridge 插件：两个 conversation Definition 发布的 Location data key 违反 DSH 0.1.1-rc.2 client runtime 的契约（`data.key === definition.kind`），导致每次会话快照重建抛异常，UI 永远冻结在“运行中”的乐观状态。**

## 1. 故障现象

在 VS Code 的 DeepSeek Harness 侧边栏中发送“你好”后：

- 页面一直显示 `Deep diving...`；
- “你好”仍像是留在底部排队区；
- 已生成的助手回复没有显示出来；
- “结束对话”也无法使界面恢复；
- 重载窗口、重装扩展、重装 DSH、清除会话后仍能复现。

## 2. 最重要的已证实事实

这不是一次单纯的模型无响应。故障会话的后端事件已经完整结束。

最近一次明确复现的会话：

- 会话 ID：`session-ae11fcef-88b3-4dc4-a338-4c66b952567a`
- 工作目录：`D:\michael_codes\dsh-vscode`
- 用户消息：“你好”
- 会话标题：`你好与欢迎问候`
- `session.list` 返回：`running: false`
- `session.history` 中存在完整助手回复
- 事件序列中存在：
  - seq 4：用户消息进入队列
  - seq 5：`turn/start`
  - seq 7：`step/start`
  - seq 8：用户消息
  - seq 82：完整的 `assistant/message`
  - seq 83：`step/end`
  - seq 84：`turn/end`，结果为 `{kind: "completed"}`
- projection 已推进至 seq 84，`turns=1`、`steps=1`、`blank=false`

因此已经确认：

1. 用户消息到达了 DSH 后端；
2. 模型请求成功；
3. 助手回复成功生成并写入会话历史；
4. turn 和 step 均正常结束；
5. 服务端认为会话不再运行；
6. 只有前端仍停留在“思考中/排队中”的旧状态。

## 3. 当前环境

| 项目 | 当前值 |
| --- | --- |
| DSH | `0.1.1-rc.2` |
| VS Code 扩展 | `michael-lee.dsh-vscode@0.2.1` |
| Git 分支 | `main` |
| 最近相关提交 | `d38b396`、`17f87b4` |
| DSH 服务端口 | `53587`（记录本次检查时的值，重启后可能变化） |
| DSH 服务 PID | `6336`（记录本次检查时的值，重启后可能变化） |
| VS Code Extension Host PID | `41768`（记录本次检查时的值） |
| DSH instance ID | `d8eeab51-1d91-4034-b12a-af0a0dcba24f` |

本次检查时，DSH 端口可以正常返回 HTTP 200。

模型配置也正常：

- provider：`deepseek-official`
- model：`deepseek-v4-flash-vision-exp`
- `routable: true`
- provider failures：空数组

不仅模型目录可用，实际“你好”请求也已经产生完整回复，所以模型供应商不是本故障的主要嫌疑。

## 4. 当前数据与日志位置

### DSH 数据

- DSH 主目录：`C:\Users\Mike Lee\.dsh`
- 会话文件：`C:\Users\Mike Lee\.dsh\sessions\...\session.jsonl.zstd`
- 会话投影缓存：`C:\Users\Mike Lee\.dsh\storages\session_projcache.json`
- 工作区注册表：`C:\Users\Mike Lee\.dsh\storages\workspace.json`
- 凭据文件：`C:\Users\Mike Lee\.dsh\.credentials.yaml`
- Web profile：`C:\Users\Mike Lee\.dsh\profiles\web`

### VS Code 数据

- DSH 服务记录：`C:\Users\Mike Lee\AppData\Roaming\Code\User\globalStorage\michael-lee.dsh-vscode\dsh-server.json`
- DSH Output 日志根目录：`C:\Users\Mike Lee\AppData\Roaming\Code\logs`
- 本次相关日志目录：`C:\Users\Mike Lee\AppData\Roaming\Code\logs\20260905T133602\window1\exthost\output_logging_20260905T134834`
- WebView Local Storage LevelDB：`C:\Users\Mike Lee\AppData\Roaming\Code\Local Storage\leveldb`
- VS Code 用户设置：`C:\Users\Mike Lee\AppData\Roaming\Code\User\settings.json`
- 用户设置备份：`C:\Users\Mike Lee\AppData\Roaming\Code\User\settings.json.dsh-vscode.bak`

日志中出现过以下状态：

```text
sidebar WebviewViewProvider registered
[stale] a dsh instance from a previous session is still running ... — leaving it alone
reusing existing dsh instance from another window
sidebar view resolved (visible=true)
```

## 5. 最近观察到的会话

| 会话 ID | 工作目录 | turns | blank | openStep | 服务端 running |
| --- | --- | ---: | --- | --- | --- |
| `session-4111d6f8-1d6f-470c-a108-f73c7a80df8e` | `D:\michael_codes\dsh-vscode` | 0 | true | false | false |
| `session-ae11fcef-88b3-4dc4-a338-4c66b952567a` | `D:\michael_codes\dsh-vscode` | 1 | false | false | false |
| `session-32dc4a80-578e-408f-a193-5d929f5f6b50` | `D:\michael_codes` | 1 | false | false | false |

界面卡住时，权威的服务端 `session.list` 对这些会话均返回 `running: false`。

## 6. 已经尝试过的处理

以下操作均未从根本上消除故障：

1. 检查原始故障会话，确认后端其实已经完成回复。
2. 在 bridge client 中增加状态看门狗：
   - WebView 可见且本地状态为 `running=true` 时，每 5 秒查询权威 `session.list`；
   - 连续两次发现“本地仍运行、服务端已空闲”时刷新页面；
   - 已为该逻辑添加测试。
3. DSH 服务参数增加 `--no-open`。
4. 全局卸载并重装 `@deepseek-ai/dsh@0.1.1-rc.2`。
5. 多次清理会话目录和会话投影缓存。
6. 卸载并重新安装 `michael-lee.dsh-vscode@0.2.1` VSIX，以销毁并重建 WebView。
7. 重新安装 DSH bridge，并核对安装文件哈希。
8. 清理过期 workspace session 引用，重新创建当前项目 workspace。
9. 启用 `dsh.autoStart` 并多次重启 Extension Host。
10. 检查多 WebSocket 客户端：服务端向两个客户端广播了相同帧，基本排除了“消息被另一客户端抢走”。
11. 检查新 iframe/浏览器连接：WebSocket 能建立且可以收到帧，基本排除了底层网络不通。

## 7. 已修复但不是当前卡死根因的问题

集成测试以前会污染真实的 `C:\Users\Mike Lee\.dsh` 数据。该问题已在提交 `d38b396` 中修复：

- `extension/test/server-manager.integration.test.ts` 为测试设置独立的临时 `DSH_HOME`；
- 测试前后真实 `workspace.json` 的 SHA256 保持不变；
- 真实会话文件数量保持不变；
- 19 个测试文件全部通过。

不要使用 `d38b396` 之前的版本运行集成测试，否则可能再次污染本机真实 DSH workspace 数据。

提交 `17f87b4` 增加了嵌入式会话的陈旧 running 状态恢复逻辑，但目前仍不足以覆盖本次 UI 卡死。

## 8. 可能原因（按优先级排序）

### P0：最可能

#### 8.1 前端 store 没有把已完成事件投影到正在显示的会话

服务端已有 `assistant/message`、`step/end` 和 `turn/end`，而界面仍显示运行中。这说明可见组件使用的状态没有随着事件更新，或者组件订阅的是错误/过期的 store。

应重点检查：

- `host/session-status` 的处理；
- `turn/end` 与 `step/end` 的 reducer/projector；
- 会话重新连接后 history baseline 与实时事件的合并；
- 当前会话切换时订阅是否仍绑定旧 session ID；
- 对话组件渲染所读的 store 是否和 bridge 所读的 store 是同一个实例。

#### 8.2 现有看门狗没有真正覆盖产生 spinner 的状态

当前看门狗只会在以下条件全部满足时运行恢复：

- 页面位于 iframe 中：`currentWindow.parent !== currentWindow`；
- WebView 可见；
- 当前会话在看门狗所读 store 中是 `running === true`；
- 连续两次发现服务端已空闲。

如果 `Deep diving...` 来自另一个队列/展示状态，而 `ctx.sessions` 已经是 `running=false`，看门狗不会触发。另一个可能是 bridge 和 UI 加载了两个 client-runtime 实例，看门狗监控的并不是正在渲染的那个实例。

#### 8.3 localhost origin 下持久化的 WebView 状态损坏或互相冲突

在 VS Code WebView 的 LevelDB 中发现了这些 DSH 键：

- `dsh.sessions.current`
- `dsh.workspace.view.v5`
- `dsh.conversation.chat.session-<id>`

并发现多个旧 localhost origin，例如：

- `http://127.0.0.1:53995/`
- `http://127.0.0.1:57173/`

持久化状态可能保留了旧会话选择、乐观队列、草稿或 view state。端口每次变化又会形成新的 origin，使数据迁移和恢复路径更复杂。

需要在实际 WebView 的开发者工具中，对当前 origin 做**定向检查和定向清理**，或者在 bridge 中写一次性 migration。不要直接删除整座 LevelDB。

#### 8.4 spinner/排队区使用了不同于 `session.running` 的状态源

从现象看，页面上的 `Deep diving...` 和底部排队消息可能由 conversation queue、agent driver 或 presentation state 控制，而不是权威的 `session.running`。需要直接追踪本版本 UI 中 spinner 和 queued-message 组件的 selector。

### P1：较可能

#### 8.5 WebSocket 重连时序竞争

可能的竞态流程：

1. 页面从 LocalStorage 恢复当前会话；
2. UI 显示乐观 running/queued 状态；
3. 服务端在订阅完全绑定之前发送了 baseline 或结束事件；
4. UI 丢失或忽略 `turn/end`；
5. 后续没有权威 reconciliation，因此永远停留在旧状态。

特别要检查 `session.list` baseline、history tail、`host/session-status` 与 live event 的处理顺序，以及 last sequence number 的去重条件。

#### 8.6 client runtime 被重复打包/加载

bridge 导入 `@deepseek-ai/dsh-client-runtime/client`，UI bundle 也可能包含另一份 runtime。若存在两个模块实例，会出现：

- bridge 看见的会话已空闲；
- UI 渲染 store 仍卡住；
- 看门狗刷新/修复了错误的上下文。

应在两个入口打印 runtime 单例标识、store 对象标识和当前 session ID。

#### 8.7 VS Code WebView 保活导致坏状态长期存在

侧边栏使用 `retainContextWhenHidden: true` 时，隐藏/显示不会真正销毁页面。需要临时验证：

- 改为 `retainContextWhenHidden: false`；
- 或在 reveal 时明确重建 `webview.html`；
- 或换一个临时 view ID，强制创建全新 WebView。

如果这样能恢复，问题就在 retained WebView state 或恢复流程。

#### 8.8 扩展采用了“上一会话遗留”的 DSH 进程

日志显示扩展会采用已存在的 DSH 实例，而不是始终自己创建并持有 child process。此前也出现过 `dsh-server.json` 指向死亡 PID/端口的情况。

虽然当前实例健康，但采用外部/旧实例后的生命周期、onReady、健康检查和 reconnect 行为可能与扩展自行启动的实例不同。建议只通过 `ServerManager` 启动服务，并为 adopted process 增加持续健康检测和失效记录清理。

### P2：次要可能

#### 8.9 DSH `0.1.1-rc.2` 本身的前端缺陷

当前安装的是 release candidate。若干后端路径正常，但前端恢复/投影可能有版本缺陷。应与上一个可用版本或更新版本做隔离对比。

#### 8.10 其他 VS Code UI 扩展发生冲突

本机日志中见到：

- `BrandonKirbyson.vscode-animations`
- `subframe7536.custom-ui-style`

它们更可能影响渲染而不是 DSH 后端状态，但仍建议使用全新的 VS Code user-data-dir，只安装 DSH 扩展做一次对照测试。

#### 8.11 Renderer 内存或性能压力

此前 `code --status` 看到系统空闲内存约 1.6–2.2 GB（总内存约 15.7 GB）。这可能放大 WebView 卡顿，但目前没有 renderer 崩溃的直接证据，优先级较低。

## 9. 建议下一位工程师首先执行的定位步骤

### 第一步：直接观察发生故障的 WebView

打开 VS Code Developer Tools，定位当前 DSH iframe/origin，检查：

1. 当前 origin 下的 LocalStorage：
   - `dsh.sessions.current`
   - `dsh.workspace.view.v5`
   - 当前会话对应的 `dsh.conversation.chat.*`
2. `/api/events.mux` WebSocket frames 是否收到：
   - `assistant/message`
   - `step/end`
   - `turn/end`
   - `host/session-status` 且 `running=false`
3. 收到 `turn/end` 后，UI store 中以下值：
   - current session ID
   - running
   - queued message count
   - open step
   - last applied sequence

这一步可以快速区分“结束帧没进 WebView”和“结束帧已进 WebView但 reducer/组件没更新”。

### 第二步：在 client runtime 中加定点日志

建议在以下位置加入结构化日志：

- `SessionRuntime.projectList`
- `SessionManager`
- `handleHostEnvelope`
- `followCurrent`
- conversation queue store
- `Deep diving...` 组件使用的 selector

每条日志至少包含：

```text
runtimeInstanceId
storeInstanceId
currentSessionId
eventSessionId
eventType
eventSeq
localRunning
serverRunning
queuedCount
lastAppliedSeq
documentVisibilityState
```

同时让看门狗每次启动时输出一次 heartbeat，以确认它确实挂载在当前可见页面中。

### 第三步：做两个隔离对照

#### 对照 A：独立浏览器

直接访问当前 DSH 地址，例如 `http://127.0.0.1:53587`，新建会话并发送“你好”。

- 浏览器正常、VS Code WebView 异常：重点检查 iframe、parent bridge、VS Code WebView storage 和 retained context。
- 两边都异常：重点检查 DSH client runtime、会话投影与 queue store。

#### 对照 B：全新 VS Code 用户数据目录

使用一个新的、独立的 `--user-data-dir`，只安装当前 DSH 扩展进行测试。不要删除现有用户数据。

- 新环境正常：说明现有 WebView storage、扩展组合或用户配置存在冲突。
- 新环境仍异常：说明问题更接近扩展/DSH 自身代码。

### 第四步：临时绕开 retained WebView

将 `retainContextWhenHidden` 临时改为 `false`，或者在 reveal 时强制重建 HTML，再重复“你好”测试。这个试验比继续反复重装更有信息量。

### 第五步：实现明确的前端恢复入口

建议增加“恢复会话 UI”命令或按钮，只对当前 DSH origin 执行：

1. 请求权威 `session.list` 和当前 `session.history`；
2. 重建当前会话的前端 projection；
3. 清除当前会话的 optimistic queue/view state；
4. 保留真实会话历史和凭据；
5. 必要时重载 iframe。

## 10. 不建议再做的操作

1. **不要删除整个** `C:\Users\Mike Lee\AppData\Roaming\Code\Local Storage\leveldb`。它由多个 VS Code WebView/扩展共享，可能破坏其他扩展状态。
2. 不要把界面 spinner 当作服务端仍在运行的证据，应以 `session.list` 和 `session.history` 为准。
3. 不要删除 `C:\Users\Mike Lee\.dsh\.credentials.yaml`，除非用户明确要求重新配置凭据。
4. 不要继续用“反复全局重装”替代状态链路定位；DSH 已经重装过，模型请求也已证实完成。
5. 不要用 `d38b396` 之前的集成测试代码连接真实 `.dsh` 目录。
6. 不要手工伪造 `dsh-server.json` 作为长期方案；服务进程应由扩展正常管理。

## 11. 建议的验收标准

修复应同时满足：

1. 发送“你好”后，消息立即离开排队区并进入对话流；
2. 助手回复能够实时显示；
3. 收到 `turn/end` 后，`Deep diving...` 在合理时间内消失；
4. “结束对话”可用；
5. 无需刷新或重载 VS Code；
6. 隐藏并重新打开侧边栏后状态仍正确；
7. 重启 VS Code 后能恢复正确会话，不生成重复空白会话；
8. 同一会话的 UI 状态、`session.list` 和 `session.history` 一致。

## 12. 一句话交接结论（历史，2026-09-05 早前）

**后端、模型调用、会话落盘和结束事件均已证实正常；排查方向随后被第 13 节的定位过程收束为 DSH 前端状态投影问题，并最终确认根因在扩展自己的 bridge 插件。**

## 13. 根因与修复（2026-09-05 已确认并修复）

### 13.1 定位过程（对照 A：独立浏览器）

在全新 Edge 无头浏览器（临时 user-data-dir、CDP 驱动，见 `scripts/spa-driver.cjs`）中直接访问 DSH 页面并发送“你好”，故障**同样复现**，从而排除了 VS Code WebView、iframe、retained context 等 VS Code 专属因素（手交单 8.3/8.7/8.10 排除）。

逐层取证结果：

1. 服务端与线路完全健康（`scripts/repro-turn.cjs`、`scripts/probe-mux.cjs`）：帧序完整（queue → turn/start → step/start → user/message → assistant/chunk* → host/session-status running:false → assistant/message → step/end → turn/end），`session.list` 为 `running:false`。
2. 页面自己的 WebSocket 确实收到了全部帧（CDP Network 层捕获），`host/session-status running:false` 也在页面内。
3. 在 client runtime 加定点日志（临时、已还原）确认：帧全部被 `Session` 对象应用，无 drop、无 gap，`handleRunning(false)` 正常执行且 `running` 位已翻转为 false。
4. 但页面 UI 仍冻结。进一步加日志（同样已还原）发现：**`Session` 的 notifier 每次 rebuild 都抛出异常**，`snapshotCache` 停留在事件到达前的乐观状态（`running:true` + queue 中 1 条 steering 项 + 0 个节点），UI 读到的正是这份冻结缓存；看门狗读到的 `getSnapshot()` 也是同一份缓存，因此即使 reload 也会在 bridge 重新注册后再次复冻——这与“重载、重装均无效”的现象完全吻合。

### 13.2 根因

`packages/dsh-vscode-bridge/lib/client.js` 中两个 conversation Definition：

- `diffPreviewsDefinition`（kind：`dsh-vscode-diff-previews`）
- `applyProposalsDefinition`（kind：`dsh-vscode-apply-proposals`）

其 `buildLocationData` 发布的 Location data key 使用了驼峰命名（`dshVscodeDiffPreviews` / `dshVscodeApplyProposals`）。而 DSH 0.1.1-rc.2 client runtime 在 `ConversationNodeAssembler.buildLocationData` 中强制校验 **`data.key === definition.kind`**（发布者只能发布自己 kind 名下的数据）：

```text
Error: conversation Definition "dsh-vscode-diff-previews" published Location data key "dshVscodeDiffPreviews"; expected its owned kind
```

该异常在 `Session` 的 notifier rebuild 闭包（`conversation.flush()` + `buildSnapshot()`）内抛出，导致：

- 每次事件到达 → markDirty → flush → rebuild 抛异常 → `snapshotCache` 永不更新；
- UI（spinner 门控 `useSession(s => s.running)`、排队气泡、消息流）全部冻结在乐观状态；
- 看门狗与 UI 读同一份冻结快照，本地永远 `running:true`；
- reload 无效：bridge 每次页面加载都会重新注册错误的 Definition，首个事件到达后再次冻结。

### 13.3 修复

将 Location data key 与 Definition kind 对齐（共 6 处）：

- `packages/dsh-vscode-bridge/lib/client.js`：两个 `buildLocationData` 的 `key`、两个读取处 `owner.turn.data.get(...)`；
- `extension/test/bridge-client-apply-edit.test.ts`、`extension/test/bridge-client-editor-context.test.ts`：测试 fixture 同步；
- 已同步修复用户当前安装的扩展副本（`~/.vscode/extensions/michael-lee.dsh-vscode-0.2.1/dist/dsh-vscode-bridge/lib/client.js`），repo 的 `extension/dist` 已通过 `npm test`（含 esbuild 复制步骤）重建。

### 13.4 验收证据

修复后 `scripts/spa-driver.cjs` 实测（干净状态、无任何调试补丁）：

- 发送“你好，请只回复 pong 两个字”后约 935ms spinner 出现；
- 约 1938ms spinner 消失且回复“pong”已渲染（`OUTCOME: rendered`）；
- rebuild 异常次数为 0；
- 会话快照终态：`running:false`、`queueLen:0`、`orderLen:6`，与服务端一致；
- 扩展 19 个测试文件全部通过。

对应验收标准（第 11 节）1/2/3/5/8 已在独立浏览器验证；4/6/7 需在 VS Code 侧人工复核（当前安装副本已生效，无需重装 VSIX）。

### 13.5 遗留事项

1. **诊断产生的测试会话**：定位过程中在真实 `C:\Users\Mike Lee\.dsh` 数据中留下了若干测试会话（`session-b4500809-…`、`session-ed2622bd-…`、`session-1b0e3de1-…`、`session-6d4797b6-…`、`session-8c88f65b-…`、`session-1e6205df-…`、`session-37df26ea-…`、`session-4c9d8517-…`、`session-3dbcdd32-…`、`session-92c40f74-…`、`session-55aa9472-…`）。当前 DSH 0.1.1-rc.2 没有 `session.delete` API，为避免手工改写会话文件，未做清理，由用户决定处理方式。
2. **独立观察（与本 bug 无关，未修）**：DSH SPA 每次在全新浏览器 profile（无 localStorage）启动时会自动为当前 workspace 新建并选中一个空白会话。由于 VS Code WebView 的 origin 随端口变化，端口变更后 localStorage 重新初始化，会再次触发“自动新建空白会话”，这可能是验收标准 7（重启不生成重复空白会话）所担心的现象来源，建议作为后续独立问题处理（需要 DSH 上游支持或扩展侧显式恢复持久化选择）。
3. 诊断期间对全局 DSH 安装与安装版 bridge 做的临时打点均已按备份还原，当前在线文件为“原始 + 修复”状态。

### 13.6 诊断工具

新增于 `scripts/`：

- `probe-mux.cjs` — 观察 mux/host 初始帧与广播；
- `repro-turn.cjs` — 走一遍完整 wire 流程并打印所有帧；
- `spa-driver.cjs` — 无依赖 CDP 驱动真实浏览器执行“对照 A”（启动 → 等待 SPA → 对当前会话发 prompt → 观察 DOM 与页面内 WS 流量 → 对比服务端权威状态）。
