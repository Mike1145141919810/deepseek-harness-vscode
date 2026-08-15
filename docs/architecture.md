# dsh-vscode 架构记录

## 架构决策（已批准，PLAN.md v2）

- 扩展宿主拉起 `dsh web`（强制 `--host 127.0.0.1`，扩展预分配端口），WebviewPanel iframe 加载。
- 前端/后端零分叉；扩展不捆绑 dsh；`browser` = 系统默认浏览器；`extensionKind: ["workspace"]`。

## Phase 0.5 iframe 可行性 spike

**状态：待执行**

- 协议层（无 VS Code）：`npm test` 中的 `server-manager.integration.test.ts` —— 真实 dsh 拉起、HTTP 200、WS upgrade 应答、关闭后端口释放。
- 宿主层（真 VS Code）：`npm run smoke` —— 扩展开发宿主内激活扩展、`dsh.open`、服务健康。
- 视觉/交互层（人工清单，README 验收清单）：GUI 完整加载、会话闭环、审批弹窗、skill 列表、隐藏/重开面板。

结论与任何回退决策（browser 形态等）在 spike 完成后回填本节。

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
