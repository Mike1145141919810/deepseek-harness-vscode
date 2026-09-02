# dsh-vscode 架构记录

## 架构决策（已批准，PLAN.md v2）

- 扩展宿主拉起 `dsh web`（强制 `--host 127.0.0.1`，扩展预分配端口），WebviewPanel iframe 加载。
- 前端/后端零分叉；扩展不捆绑 dsh；`browser` = 系统默认浏览器；`extensionKind: ["workspace"]`。

## Phase 0.5 iframe 可行性 spike

**状态：✅ 全部通过（2026-08-15）——iframe 架构锁定**

- **协议层**（`npm test` 中的 `server-manager.integration.test.ts`，13/13 通过）：
  - ServerManager 真实拉起 `dsh web --host 127.0.0.1 --port <预分配>`（本机 npx-cache 安装的 rc.6）。
  - `GET /` → 200（SPA index + `window.__DSH_BOOT__` 注入正常）。
  - WebSocket downlink：`/api/events.mux` 原始 upgrade 握手 → `HTTP/1.1 101`；对正在运行的 harness GUI（3080）握手同样 101 且能收到会话帧（session/subscribed 等）。
  - 关闭序列：`taskkill /T /F` → 进程退出、端口释放（后续 GET 拒绝连接）。
- **宿主层（真 VS Code）**：扩展开发宿主内激活、`dsh.open`、服务健康——通过（smoke 测试 + 用户实机验证）。
- **视觉层（人工验收）**：用户在真实 VS Code 面板内看到完整 DSH GUI——通过 ✅。
- **关键发现 1（竞态）**：dsh 的 WS upgrade 路由在 `apiProxy` 服务就绪后才注册，晚于 HTTP 监听开始应答。HTTP-ready 后立刻握手会撞空窗（upgrade 表为空 → 服务器静默销毁 socket，0 字节断连）。浏览器 GUI 自己的 WS 客户端会重连，不影响产品；测试用 5 次重试（500ms 间隔）吸收该竞态。若将来要在"就绪"判定中包含 WS 可用性，需等待 `/api/events.mux` 101。
- **关键发现 2（Electron）**：VS Code 扩展宿主里 `process.execPath` 是 Code.exe（Electron），用它执行 `bin.js` 会永远起不来（且 dsh 的 node-pty 按 node ABI 编译）。修复：Electron 环境优先从 PATH 找真 `node.exe`，找不到退回 `ELECTRON_RUN_AS_NODE=1`。
- **关键发现 3（enableScripts）**：`createWebviewPanel` 的 `enableScripts: false` 作用于**整个 webview 上下文（iframe 在内）**，会禁掉 SPA 的脚本 → 面板空白。必须 `true`；父文档自身无脚本 + 严格 CSP 保证安全。
- **关键发现 4（排除项）**：曾怀疑继承 harness 的 `DSH_*` 环境变量干扰子进程 dsh 的 WS 行为；bisect 实验证明与 env 无关（干净 env 与完整继承 env 行为一致），根因是发现 1 的时序竞态。

## 关键模块

| 模块 | 职责 |
|---|---|
| `src/server-manager.ts` | dsh 定位（binPath → PATH → npx 开关）、端口预分配、spawn、健康探活、状态机、进程树清理、实例记录持久化 + stale 检测、关停后端口校验 |
| `src/instance-record.ts` | 实例记录（PID/端口/启动时间/实例 ID）读写与 PID 存活检测（纯 Node） |
| `src/stdout-adapter.ts` | stdout 启动行的版本敏感解析（仅诊断） |
| `src/security.ts` | extraArgs 安全边界校验（纯函数，无 vscode 依赖） |
| `src/gui-panel.ts` | WebviewPanel + CSP + iframe；崩溃时重连页、恢复时重渲染 |
| `src/sidebar-view.ts` | WebviewViewProvider（活动栏侧边栏）：未就绪占位页、崩溃重连页、就绪 iframe |
| `src/gui-common.ts` | 面板/侧边栏共享：模板读取 + 工作区文件夹预注册 |
| `src/webview-html.ts` | webview HTML 渲染与 nonce 生成（纯函数，无 vscode 依赖） |
| `src/settings.ts` | 配置访问（vscode 依赖层） |
| `src/editor-bridge.ts` | 纯解析 `dsh.openInEditor` 消息（绝对路径/行列校验，无 vscode 依赖） |
| `src/editor-bridge-vscode.ts` | 打开文件/定位光标（vscode 依赖层） |
| `src/apply-edit.ts` | Phase 2D 严格写回协议、路径/preimage 策略与请求防重放（纯 Node） |
| `src/apply-edit-vscode.ts` | Phase 2D 原生 diff/模态确认、重复安全校验、单 undo 单元且不自动保存 |
| `src/logger.ts` | 输出通道 |
| `packages/dsh-vscode-bridge` | DSH web profile 客户端插件：产物行 “Open in VS Code” 按钮 + postMessage |

## 进程生命周期

```
idle → starting → ready → (crash?) → failed → restart(1x) → ready
ready → stopping → stopped
dispose(): stopping → stopped（taskkill /T /F 于 Windows）
```

## Phase 1 实施记录

- `dsh.open` 现在遵循 `dsh.openIn` 设置：`"panel"` 开面板、`"sidebar"` 开侧边栏、`"browser"` 走系统浏览器；`dsh.openBrowser` 始终走浏览器。
- Windows PATH 发现：`where dsh` 会先列出无扩展名的 npm shim（POSIX sh 脚本，cmd 无法执行）再列出 `dsh.cmd`。发现逻辑优先选 `.exe`，其次 `.cmd`/`.bat`/`.ps1`，避免 spawn ENOENT。
- npm/npx shim 不再经 `shell: true` 启动：解析 `.cmd`/`.bat`/`.ps1`/无扩展名 shim 指向的真实 `bin.js` 后用真实 node 直接执行（兼容两种布局：`node_modules/.bin` 的 `%dp0%\..\pkg\lib\bin.js` 与 npm ≥10 全局 prefix 的 `%dp0%\node_modules\pkg\lib\bin.js`）。绕开两处 Windows 坑——用户目录含空格时命令行被截断（`'C:\Users\Mike' is not recognized`）、cmd 参数不加引号拼接（DEP0190），并保证记录的 pid 就是真实 node 进程。
- spawn 错误（如 ENOENT：可执行文件缺失或 npx 缓存 shim 失效）立即失败并给出可操作提示，不再空等完整健康超时。
- 实例记录持久化（globalStorage/dsh-server.json）：每次就绪写入、干净停止删除；每次冷启动做 stale 检测——旧 PID 仍存活且端口仍在应答则告警保留，否则清记录并告警。
- 面板崩溃 UX：`failed` 状态触发重连页（CSP nonce 限定的单按钮脚本，postMessage 重试）；服务恢复时 onReady 自动重渲染 iframe。
- 关停序列在进程退出后追加端口释放校验（3 次探测），端口仍被应答时只告警、绝不杀掉非本扩展进程；集成测试新增「停止后进程计数回到启动前基线」断言。

## Phase 1.5 实施记录

- `sidebar` 形态已落地：`dsh.openIn` 扩展为 `"panel" | "sidebar" | "browser"`；活动栏视图 id 为 `dsh.sidebarView`（WebviewViewProvider，`src/sidebar-view.ts`）。**关键：`contributes.views` 里的视图必须声明 `"type": "webview"`**，否则 VS Code 按树视图处理、`registerWebviewViewProvider` 不会解析（表现为「没有可提供视图数据的已注册数据提供程序」）；曾复用旧树视图 id `dsh.openView` 加深了混淆，故同时换了新 id。
- 侧边栏状态机：未就绪 → 占位页（Open 按钮，不在 reveal 时自动拉起服务）；`failed` → 重连页（nonce 脚本 + Retry）；`ready` → iframe；`stopped` → 回到占位页。
- 面板与侧边栏共用：iframe/reconnect/sidebar-empty 模板 + `webview-html.ts` 渲染 + `gui-common.ts` 的工作区预注册。
- 跨窗口单实例：`ServerManager` 启动时先读 globalStorage 实例记录，若 PID 存活且端口应答则直接采用（`ownsServer=false`，不杀进程、不删记录）；启动竞态时后到者杀掉自己的重复进程并采用先到者；附加窗口 `Stop Server`/dispose 只 detach；`Restart Server` 在附加窗口会按 PID 树杀共享实例后由本窗口重建（其他窗口通过记录竞态收敛）。
- `dsh.runTask`（headless）：命令 `DSH: Run Task (headless)` 输入任务文本，`src/headless.ts` 构建 `dsh --profile headless "<task>"` 集成终端调用——node-bin 走 argv 数组（无 shell 引号问题），path/npx 走 cmd/sh。
- 尚未实现（Phase 1.5 剩余）：无（sidebar、单实例、runTask 均已落地）。后续可做跨窗口 IPC 精化、终端结果收集。
- 已知环境坑：`window.showInformationMessage`（无按钮）在自动化测试里会挂起命令返回，扩展内已改为 fire-and-forget；`dsh.stopServer`/`dsh.restartServer` 均不再 await 无操作通知。
- `npm test` 改用 `test/run-unit-tests.js` 逐文件运行（兼容 Node 18/20/24，目录参数在 Node 24 已不可用），并新增 `tsc --noEmit` 类型检查；`smoke.test.js` 只由 `test:smoke` 运行。

## Phase 2A 实施记录：Open in VS Code（实现与分发完成，GUI 点击待人工复核）

- **目标链路**：DSH web 前端（`http://127.0.0.1:<port>`）里的产物文件行显示 **Open in VS Code** 按钮 → `window.parent.postMessage({ type: 'dsh:openInEditor', file })` → 父 webview 文档的 nonce 脚本校验 `event.origin` 为 loopback 后转发 `dsh.openInEditor` → 扩展宿主 `GuiPanel`/`SidebarView` 调用 `editor-bridge-vscode.openInEditorFromMessage` → `vscode.workspace.openTextDocument` + `showTextDocument` + 光标定位。
- **父文档脚本**：`media/panel.html` 从“无脚本”升级为唯一 nonce-gated 脚本（CSP 增加 `script-src 'nonce-{{NONCE}}'`，保留 `frame-src http://127.0.0.1:*`）；`webview-html.renderIframeHtml` 现在同时填充 `{{DSH_URL}}` 与 `{{NONCE}}`。
- **扩展侧消息校验**：`src/editor-bridge.ts`（纯 Node）校验 `dsh.openInEditor` 的 `file` 必须是绝对路径、`line`/`character` 必须是非负整数；`src/editor-bridge-vscode.ts` 负责实际打开。校验不过/文件不存在会记录输出通道并弹警告，不静默。
- **DSH 客户端插件**：`packages/dsh-vscode-bridge` 注册 `conversation.chat.turnTail` chain 条目（`priority: -1`，先于 stock `ProducedFiles`），复用 `@deepseek-ai/dsh-client-ui-deliverables/client` 的 `ProducedFiles` 与 `producedForClosing`，在产物行下追加 “Open in VS Code” 按钮。相对路径用 `resolveWorkspacePath(cwd, path)` 转绝对路径。
- **安装与分发**：构建时把 `packages/dsh-vscode-bridge` 的运行文件复制进 VSIX；`DSH: Install VS Code Bridge` 经模态确认后调用 `dsh plugin --profile web add -w <bundled-path>`，确认依赖已落盘后再幂等写入 loader 条目。修改 `cordis.patch.yml` 前保留备份，结束时必须重新检测为 `installed`。`DSH: Check Installation` 会分别报告依赖、模块和 loader 状态。
- **验收（2026-08-25）**：真实 `dsh web` 返回 `__DSH_BOOT__` 含 `dsh-vscode-bridge` 且 `/plugins/dsh-vscode-bridge/client.js` 200；VS Code smoke 的 `dsh.openInEditor` 用例通过；一键安装后端在隔离 `DSH_HOME` 中真实调用 DSH/pnpm，依赖、备份、loader、最终状态和清理全部通过。真实 GUI 内点击按钮仍待肉眼复核。
- **Phase 2 状态**：2A～2D 均已完成；2D 采用 DSH 提案、VS Code 原生确认和确认后重复校验的写回模型，详见 `phase-2d-safety.md`。

## Phase 2B 实施记录：编辑器上下文（读取层与 Host 注入已完成，通道待接）

- **显式读取语义**：`src/editor-context-vscode.ts` 仅跟踪仍打开的本地 `file:` 文本编辑器；焦点进入 Webview 后回退到最后一个有效编辑器。真正请求时才读取主选区，空选区只提供文件/语言/光标，不复制当前行或全文。
- **有界 DTO**：`src/editor-context.ts` 输出版本化 JSON（本地路径、file URI、语言、documentVersion、dirty、1-based 光标/选区）；选区最多 16,384 UTF-16 code units，并携带 `truncated`。内部命令 `dsh.getEditorContext` 是后续 Webview handler 的读取 seam，未贡献到命令面板。
- **正式 Host 注入点**：bridge 注册 `/vscode-context <editor-context-json>`，设置 `recordInput: false`，严格拒绝未知字段、错版本、非绝对路径、非 file URI、非法坐标与超限文本；合法输入构造成 `source.kind='plugin'`、`form='snapshot'` 的 UserMessage，并调用 `invocation.agent.inject()`。不调用 `followup`/`steer`，因此不会唤醒空闲会话。
- **链接安装兼容**：Web profile 使用 `link:` 指向 bridge 的真实目录，Host 入口不能裸导入只存在于 DSH 分发目录内的包。bridge 按 DSH `UserMessage` 公共形状本地构造 UUID、role 与深冻结消息，避免 realpath 模块解析失败；真实 `dsh web` 集成测试已验证插件树可加载。
- **双向父页面通道**：`media/panel.html` 只接受 `event.source === iframe.contentWindow` 且 `event.origin === new URL(iframe.src).origin` 的上行；`dsh:requestEditorContext` 转为 Host 消息后，由 Panel/Sidebar 共用 `webview-bridge-vscode.ts` 读取上下文并生成结构化成功/错误响应，再只向精确 `dshOrigin` 下发 `dsh:editorContext`，禁止 wildcard target。requestId 与点击时 sessionId 全程原样关联并做长度/控制字符校验。
- **剩余链路**：DSH client 会话按钮与响应监听 → 发起 requestId/sessionId 请求 → 收到成功上下文后对点击时的会话调用 `SessionFace.command`，并展示错误/超时状态。该 client 适配接通前不在 README 声称 2B 可用。

## 开发与测试注意事项

- VS Code ≥ 1.123 的 F5 开发宿主运行在主窗口的 utility 进程里，**不继承 workspace 级 `.vscode/settings.json`**；在开发宿主里验证设置相关行为时一律用**用户级**设置。
- 仓库不提交机器相关的 `dsh.binPath` workspace 设置（npx 缓存路径会失效）。本机验证环境用 `npm install -g @deepseek-ai/dsh@0.1.1-rc.2`（与 `dsh.pinnedVersion` 一致），空 `binPath` 即可自动发现。
