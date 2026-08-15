# dsh-vscode 架构记录

## 架构决策（已批准，PLAN.md v2）

- 扩展宿主拉起 `dsh web`（强制 `--host 127.0.0.1`，扩展预分配端口），WebviewPanel iframe 加载。
- 前端/后端零分叉；扩展不捆绑 dsh；`browser` = 系统默认浏览器；`extensionKind: ["workspace"]`。

## Phase 0.5 iframe 可行性 spike

**状态：协议层 ✅ 通过（2026-08-15）**

- **协议层**（`npm test` 中的 `server-manager.integration.test.ts`，13/13 通过）：
  - ServerManager 真实拉起 `dsh web --host 127.0.0.1 --port <预分配>`（本机 npx-cache 安装的 rc.6）。
  - `GET /` → 200（SPA index + `window.__DSH_BOOT__` 注入正常）。
  - WebSocket downlink：`/api/events.mux` 原始 upgrade 握手 → `HTTP/1.1 101`；对正在运行的 harness GUI（3080）握手同样 101 且能收到会话帧（session/subscribed 等）。
  - 关闭序列：`taskkill /T /F` → 进程退出、端口释放（后续 GET 拒绝连接）。
- **关键发现 1（竞态）**：dsh 的 WS upgrade 路由在 `apiProxy` 服务就绪后才注册，晚于 HTTP 监听开始应答。HTTP-ready 后立刻握手会撞空窗（upgrade 表为空 → 服务器静默销毁 socket，0 字节断连）。浏览器 GUI 自己的 WS 客户端会重连，不影响产品；测试用 5 次重试（500ms 间隔）吸收该竞态。若将来要在"就绪"判定中包含 WS 可用性，需等待 `/api/events.mux` 101。
- **关键发现 2（排除项）**：曾怀疑继承 harness 的 `DSH_*` 环境变量干扰子进程 dsh 的 WS 行为；bisect 实验证明与 env 无关（干净 env 与完整继承 env 行为一致），根因即发现 1 的时序竞态。
- **宿主层（真 VS Code）**：`npm run smoke`（@vscode/test-electron + 本机已装 VS Code）——待跑。
- **视觉/交互层**（人工清单，README 验收清单）：GUI 完整加载、会话闭环、审批弹窗、skill 列表、隐藏/重开面板——待用户目视确认。

## 关键模块

| 模块 | 职责 |
|---|---|
| `src/server-manager.ts` | dsh 定位（binPath → PATH → npx 开关）、端口预分配、spawn、健康探活、状态机、进程树清理、stale 检测 |
| `src/stdout-adapter.ts` | stdout 启动行的版本敏感解析（仅诊断） |
| `src/security.ts` | extraArgs 安全边界校验（纯函数，无 vscode 依赖） |
| `src/gui-panel.ts` | WebviewPanel + CSP + iframe；服务重启时重渲染 |
| `src/settings.ts` | 配置访问（vscode 依赖层） |
| `src/logger.ts` | 输出通道 |

## 进程生命周期

```
idle → starting → ready → (crash?) → failed → restart(1x) → ready
ready → stopping → stopped
dispose(): stopping → stopped（taskkill /T /F 于 Windows）
```
