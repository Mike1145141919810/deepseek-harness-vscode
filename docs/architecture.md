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
| `src/webview-html.ts` | webview HTML 渲染与 nonce 生成（纯函数，无 vscode 依赖） |
| `src/settings.ts` | 配置访问（vscode 依赖层） |
| `src/logger.ts` | 输出通道 |

## 进程生命周期

```
idle → starting → ready → (crash?) → failed → restart(1x) → ready
ready → stopping → stopped
dispose(): stopping → stopped（taskkill /T /F 于 Windows）
```

## Phase 1 实施记录

- `dsh.open` 现在遵循 `dsh.openIn` 设置：`"panel"` 开面板、`"browser"` 走系统浏览器；`dsh.openBrowser` 始终走浏览器。
- Windows PATH 发现：`where dsh` 会先列出无扩展名的 npm shim（POSIX sh 脚本，cmd 无法执行）再列出 `dsh.cmd`。发现逻辑优先选 `.exe`，其次 `.cmd`/`.bat`/`.ps1`，避免 spawn ENOENT。
- npm/npx shim 不再经 `shell: true` 启动：解析 `.cmd`/`.bat`/`.ps1`/无扩展名 shim 指向的真实 `bin.js` 后用真实 node 直接执行。绕开两处 Windows 坑——用户目录含空格时命令行被截断（`'C:\Users\Mike' is not recognized`）、cmd 参数不加引号拼接（DEP0190）。
- spawn 错误（如 ENOENT：可执行文件缺失或 npx 缓存 shim 失效）立即失败并给出可操作提示，不再空等完整健康超时。
- 实例记录持久化（globalStorage/dsh-server.json）：每次就绪写入、干净停止删除；每次冷启动做 stale 检测——旧 PID 仍存活且端口仍在应答则告警保留，否则清记录并告警。
- 面板崩溃 UX：`failed` 状态触发重连页（CSP nonce 限定的单按钮脚本，postMessage 重试）；服务恢复时 onReady 自动重渲染 iframe。
- 关停序列在进程退出后追加端口释放校验（3 次探测），端口仍被应答时只告警、绝不杀掉非本扩展进程；集成测试新增「停止后进程计数回到启动前基线」断言。
- `npm test` 改用 `test/run-unit-tests.js` 逐文件运行（兼容 Node 18/20/24，目录参数在 Node 24 已不可用），并新增 `tsc --noEmit` 类型检查；`smoke.test.js` 只由 `test:smoke` 运行。
