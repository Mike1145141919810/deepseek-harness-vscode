# 把 DeepSeek Harness 做成 VS Code 插件 — 实施计划（v2，已吸收交叉检查反馈）

> 本文档即待审批的完整计划。v2 修订要点：新增 Phase 0.5 iframe 可行性 spike（P0 门禁）；MVP 移除 `sidebar`（WebviewView 属不同 API，延后到 Phase 1.5）；`extraArgs` 不得覆盖安全参数；端口改为扩展侧预分配 + 健康探活（stdout 正则降级为诊断用）；进程管理加固（进程树 + 验证 + 强杀 + stale 检测）；npx 兜底改为显式开关；Phase 2 拆为 2A→2D；明确 `browser` 实现与 `extensionKind`；验收标准细化为"必须通过/明确不保证"两组。

## 1. 目标与成功标准

**目标**：在项目文件夹 `D:\michael_codes\dsh-vscode` 中产出一个可打包为 VSIX 的 VS Code 扩展，让 DSH 的完整 Web GUI 直接在 VS Code 面板内运行；后续阶段叠加"编辑器原生联动"。

**成功标准（可验收）**

*MVP 必须通过*
1. `npm run compile` 与 `npx @vscode/vsce package` 成功，产出可安装的 `.vsix`。
2. 本机安装 VSIX：活动栏图标打开面板；GUI 能启动、创建 session、发送任务、agent 执行并返回结果；审批/提问弹窗可用；skill 列表可见（6 个已装 skill）；WebSocket 连接正常；agent 的文件改动在资源管理器中可见。
3. 服务只绑定 `127.0.0.1`；`extraArgs` 校验拒绝 `--host`/`--port`/`--trusted-host`；webview CSP 仅 `frame-src http://127.0.0.1:*`。
4. 常规关窗/重载/`dsh.stopServer`/`restartServer` 后**进程计数**恢复启动前水平（不只检查主 PID）；VS Code 崩溃等异常路径做"尽力清理 + 下次启动 stale 检测"。
5. dsh 缺失/网络失败区分报错，5 秒内给出可操作提示与 `dsh.checkInstall` 诊断链。
6. Phase 0.5 spike 清单（见 §5）全部通过，iframe 架构被锁定。

*MVP 明确不保证（不构成验收失败）*
拖拽文件、剪贴板特殊行为、全屏、下载、浏览器弹窗/popup、浏览器扩展 API、GUI 内多窗口 session、Remote/WSL/`vscode.dev`。

## 2. 调研结论（已从运行时代码验证的 DSH 事实）

- **CLI**：`dsh web`（= `dsh --profile web`）支持 `--host`（拒绝 0.0.0.0，默认 127.0.0.1）、`--port`（`0`=OS 分配）、`--trusted-host`；启动后 stdout 打印 `dsh web: http://127.0.0.1:<port>`（`127.0.0.1` 为代码硬编码的 LOOPBACK_HOST）。
- **前端**：`@deepseek-ai/dsh-web-frontend/dist` 为打包好的 SPA；`dsh web` 注入 `window.__DSH_BOOT__`。前端无 CSP meta、无 frame-ancestors；webserver 不输出 `X-Frame-Options`/CORS 头。
- **信任栅栏**：`/api` 按 Host 头放行 loopback + 同源浏览器标记；iframe 内文档真实 origin 即 `http://127.0.0.1:<port>`，理论上天然通过——**但 VS Code Webview 对 localhost 属于特殊场景，必须实测**（Phase 0.5）。
- **扩展机制**：Cordis 组合架构；web 配置 = `dsh-base`+`dsh-web-app` bundle，用户覆盖层在 `~/.dsh/profiles/web/cordis.patch.yml`；新增插件走 `dsh plugin --profile web add <pkg>` + patch 插入行（官方挂载点，不改发行版安装）。
- **headless 通道**：`dsh --profile headless "<task>"` 一次性执行并退出。

## 3. 技术路线决策

**选型：扩展宿主拉起 `dsh web`（强制 `--host 127.0.0.1`，扩展侧预分配空闲端口），WebviewPanel 用 iframe 加载该 URL，parent 文档 CSP meta 仅放行 `http://127.0.0.1:*` 帧。前端/后端零分叉。** 此路线以 Phase 0.5 spike 实测为前置条件。

- 否决 A「SPA 打包进扩展当 webview 本地资源」：要重实现 boot 注入与 API/WS 代理，与 dsh 版本脱节。
- 否决 B「headless API 自研聊天 UI」：等于重写整个 GUI。
- 否决 C「把 `@deepseek-ai/dsh` 打进 VSIX」：依赖含原生模块（node-pty 等），与 Electron ABI 绑定脆弱。改为运行时定位用户已装的 dsh。
- **`browser` 语义**：`dsh.openBrowser` 与 `dsh.openIn: "browser"` 一律指 `vscode.env.openExternal()`（系统默认浏览器）。VS Code 内置 Simple Browser 作为独立命令延后评估，不混入该设置项。
- **运行位置**：`package.json` 声明 `"extensionKind": ["workspace"]`（本地 Node Extension Host）；README 与 manifest 明示 "Desktop VS Code only / Local Extension Host only / Remote & vscode.dev unsupported"。

## 4. 项目结构（`D:\michael_codes\dsh-vscode`）

```
dsh-vscode/
├── extension/                    # VS Code 扩展（TypeScript + esbuild + vsce）
│   ├── package.json              # contributes + "extensionKind": ["workspace"]
│   ├── tsconfig.json / esbuild.js / .vscodeignore
│   ├── media/panel.html          # 父文档：CSP meta + 全屏 iframe（MVP 无脚本）
│   ├── src/
│   │   ├── extension.ts          # activate/deactivate、命令注册、状态栏
│   │   ├── server-manager.ts     # discover/bootstrap → 端口预分配 → 拉起 → 探活 → 生命周期/清理/stale 检测
│   │   ├── stdout-adapter.ts     # stdout 端口解析（版本敏感适配层，仅诊断用途 + fixture 测试）
│   │   ├── gui-panel.ts          # WebviewPanel 创建/复用/恢复、reconnect 提示
│   │   ├── settings.ts           # 配置项类型化访问 + extraArgs 安全校验
│   │   └── logger.ts             # 输出通道（子进程 stdout/stderr 落盘 + 实例记录）
│   └── test/
│       ├── server-manager.test.ts    # 单元：参数拼装/端口分配/状态机/extraArgs 校验
│       ├── stdout-adapter.test.ts    # fixture：当前行格式 + LAN 变体 + 未来变体
│       └── smoke.test.ts             # @vscode/test-electron + 真实 dsh web（slow）
├── packages/dsh-vscode-bridge/  # Phase 2：DSH host+client 插件
├── docs/architecture.md
├── README.md + LICENSE(MIT) + THIRD_PARTY_NOTICES
└── package.json                 # 根 npm scripts
```

## 5. 分阶段实施

### Phase 0 — 脚手架
扩展骨架；esbuild 打包 `dist/extension.js`；F5 扩展开发宿主调试闭环；`.vscodeignore`。

### Phase 0.5 — iframe 可行性 spike（**P0 门禁，通过后才锁架构**）
最小原型：spawn `dsh web --host 127.0.0.1 --port <预分配>` → Webview → iframe 加载。逐项实测并记录到 `docs/architecture.md`：
SPA 正常加载；CSS/JS 全量加载；WebSocket 连接；`/api` 调用；localStorage/sessionStorage；文件上传；popup/modal；approval 弹窗；skill 页面；长时间 session；页面刷新；panel 隐藏/重开。**任一关键项失败**：回退决策树——① 改 `dsh.openIn: "browser"` 作为 MVP 主形态；② 若浏览器形态也不足，再评估 SPA-as-local-resource 方案（否决 A 重开评估）。spike 结论写入 PLAN 修订并重新审批。

### Phase 1 — MVP 嵌入（panel + browser，无 sidebar）
- **server-manager.ts**
  - **discover（本机已有）**：① `dsh.binPath`（解析到 `lib/bin.js`，`node <bin.js>` 启动，绕开 Windows shim）→ ② PATH 上的 `dsh`。
  - **bootstrap（显式开关）**：仅当 `dsh.allowNpxFallback: true` 时才走 `npx --yes @deepseek-ai/dsh@<pinnedVersion>`；错误信息区分「未找到 dsh」与「npx 网络失败」。默认 `false`。
  - **端口**：扩展侧 `net` 探一个空闲端口（占用竞态靠重试 3 次），显式传 `--port N`；随后轮询 `GET http://127.0.0.1:N/` 探活（`/api` 健康端点实现时从 apiproxy 路由确认），20 秒超时、指数退避。
  - **stdout-adapter**：stdout 不再作为主协议，仅用于日志与诊断兜底；解析器做成版本敏感适配层，配 fixture 测试（当前行格式 + LAN 变体 + 未来变体），DSH 若提供机器可读启动输出则切换。
  - **安全参数不可覆盖**：启动参数固定 `--host 127.0.0.1 --port N`；`settings.ts` 校验 `extraArgs`，出现 `--host`/`--port`/`--trusted-host`（含 `=` 形式与重复项）直接拒绝并提示。
  - **状态机**：`idle→starting→ready→failed→stopping→stopped`；崩溃自动重启 1 次；`deactivate` 触发关闭序列。
  - **实例记录**：root PID + 进程树 + 端口 + 启动时间戳 + instanceId，写入输出通道；启动时做 stale 检测（记录 PID 已死则清锁并告警）。
- **gui-panel.ts**：`createWebviewPanel`（`retainContextWhenHidden: true`）；CSP meta `default-src 'none'; style-src 'unsafe-inline'; frame-src http://127.0.0.1:*;`（不放行 `localhost:*`，因 `--host` 固定 127.0.0.1）；崩溃/加载失败显示重连页。
- **扩展面**：命令 `dsh.open`、`dsh.openBrowser`（openExternal）、`dsh.restartServer`、`dsh.stopServer`、`dsh.showUrl`、`dsh.checkInstall`；设置 `dsh.binPath`("")、`dsh.openIn`("panel"|"browser","panel")、`dsh.allowNpxFallback`(false)、`dsh.autoStart`(false)、`dsh.extraArgs`([]，安全校验)、`dsh.pinnedVersion`("0.1.1-rc.2")；活动栏图标 + 状态栏项。
- 打包 VSIX；README（安装、依赖、配置、故障排查表、Remote 不支持声明）。

### Phase 1.1 — 可靠性 / 进程管理加固
关闭序列：`taskkill /T`（Windows 进程树）→ 等待 → 校验 PID/端口消失 → 必要时强杀；测试用**启动前/启动后/停止后进程计数**断言；异常退出留痕与重启策略；stale 锁与端口占用冲突检测完善。

### Phase 1.5 — UX
- `sidebar` 形态：新增 `sidebar-view.ts` 用 **WebviewViewProvider**（与 WebviewPanel 不同 API），`dsh.openIn` 扩展为 `"panel"|"sidebar"|"browser"`。
- 跨窗口单实例（globalStorage 锁文件 + 端口登记复用）；`dsh.autoStart`；`dsh.runTask`（headless 一次性任务跑集成终端）。

### Phase 2 — 原生编辑器联动（`packages/dsh-vscode-bridge`，按 2A→2D 递进，每步独立验收）
- **2A Open in Editor**：client plugin 给文件路径加按钮，`window.parent.postMessage` 发 `{type:'dsh:openInEditor', file, line}`；扩展 parent 文档 nonce 脚本收消息 → `vscode.window.showTextDocument`。
- **2B Read editor context**：用户显式请求时，扩展读取最后一个仍打开的本地文件编辑器/主选区（不自动读全文）→ client `SessionFace.command('/vscode-context <json>')` → Host `commands.register({ recordInput: false })` → `agent.inject(UserMessage source=plugin/form=snapshot)`；`inject` 不唤醒空闲会话。读取层、Host 命令、双向通道、client 请求适配器及会话按钮接线均已实现；安装态真实浏览器已完成按钮点击、响应回传及 Host 命令匹配验证。
- **2C Diff preview**：只采集成功 `tool/result` 的持久化 `FileDiff[]`，按轮次结束序号和文件分组；client 产物行显式按钮 → 精确 iframe source/origin 通道 → 扩展严格校验路径、结构和大小 → 内存虚拟文档 → VS Code `vscode.diff`。不读取、创建或修改目标文件；安装态真实浏览器已完成实际 React 按钮渲染、点击和父消息验证。
- **2D Apply edit**：已完成。安全门槛、协议/策略、VS Code 执行层、Webview 双向关联及提案型 `vscode_apply_diff` Host/client 链均已落地（18 个测试文件、9 项真实 VS Code smoke 及安装态真实浏览器验收全通过），见 `docs/phase-2d-safety.md`。首版限定可信本地工作区内的已有单个文本文件，采用精确 preimage、VS Code 原生 diff + 模态确认、确认后重复校验、单一 undo 单元且绝不自动保存；路径逃逸、dirty/stale 文档或任一门槛不满足时拒绝写回。
- 安装机制（2A 起）：`dsh plugin --profile web add file:../packages/dsh-vscode-bridge` + `cordis.patch.yml` 插入行；postMessage 为主通道，WS downlink 仅作备选。

### Phase 3 — 打磨与发布（开放项）
集成终端联动、设置深链、主题同步、`vscode.dev` postMessage 代理（需重新评估 Remote 约束）、Open VSX/市场发布 + CI（compile/单测/慢速烟测/VSIX 产物）。

## 6. 数据流

- **Phase 1**：命令 → 预分配端口 → spawn `dsh web --host 127.0.0.1 --port N` → 探活 → iframe 加载 → 前端同源直连 `/api`+WS（协议不变）。
- **Phase 2 出向**：host 插件工具（2D 起）→ 会话事件 → client 插件 postMessage → 扩展 → `vscode.*` API。
- **Phase 2 入向**（2B）：DSH client 显式请求 → iframe 双向 `postMessage`（requestId + 点击时 sessionId，父页精确 origin）→ 扩展读取编辑器状态 → 回传 client → `SessionFace.command` → Host `/vscode-context` → `agent.inject`（non-waking snapshot）。
- **Phase 2C 只读预览**：成功工具结果的 `FileDiff[]` → client 按轮次/文件聚合 → 用户点击 → iframe `postMessage` → 扩展内存 URI provider → `vscode.diff`；真实工作区文件不参与读取或写入。

## 7. 边界情况与失败模式

| 场景 | 处理 |
|---|---|
| dsh 未安装 | discover 失败即报「未找到 dsh」+ `dsh.checkInstall` 诊断链；npx 仅显式开启且错误单列 |
| npx 网络失败 | 与「未安装」分离报错；提示离线安装路径 |
| 端口占用 | 预分配 + 竞态重试 3 次；占用冲突检测留痕 |
| 服务中途崩溃 | 重连页 + 自动重启一次 + 输出通道留痕 |
| 常规关窗/重载 | 关闭序列（tree kill → 校验 → 强杀），进程计数验收 |
| VS Code 崩溃（无 deactivate） | 尽力清理；下次启动 stale 检测并告警 |
| iframe 被拦截/spike 失败 | 按 Phase 0.5 决策树回退 browser 形态 |
| 多窗口 | MVP 每窗口一实例（文档说明）；Phase 1.5 单例 |
| Windows 强杀子进程 | 裸 exit 1 无 signal，按终止处理不误报 |
| extraArgs 含安全参数 | 启动前校验拒绝，错误信息指明被禁参数 |
| dsh 升级漂移 | 版本钉死 + stdout-adapter 版本敏感层 + 升级跑烟测 |

## 8. 安全

固定 `--host 127.0.0.1` 且不可被配置覆盖；CSP `default-src 'none'; style-src 'unsafe-inline'; frame-src http://127.0.0.1:*;`；不引入远程内容；凭据不落明文；`--trusted-host` 不暴露为设置项（若后续需要，单独高级选项 + 文档警告）；`extensionKind: ["workspace"]` 声明本地宿主。

## 9. 测试与验收

- **单元**：参数拼装（安全参数注入即拒）、端口预分配重试、状态机迁移、extraArgs 校验、HTML/CSP 快照、stdout-adapter fixture（当前格式/LAN 变体/未来变体）。
- **集成（slow）**：真实 `dsh web` 拉起 → 探活 200 → 关闭序列后进程计数归位；`@vscode/test-electron` 冒烟断言面板内容。
- **人工清单**（README）：§1 的 MVP 必须通过项逐条勾选；spike 清单归档进 `docs/architecture.md`。

## 10. 风险与开放问题

- **风险**：webview iframe 策略随 VS Code 版本收紧 → Phase 0.5 实测 + browser 兜底；dsh rc 接口漂移 → 钉版本 + 适配层 + 烟测；webview 内原生目录选择器可用性 → spike 与人工验收覆盖。
- **实现期再定**：`/api` 健康端点确切路径；2B DSH client 按钮的反馈/超时表现；WS downlink 消息形态（2A 备选）。

## 11. 明确假设

- 桌面版 VS Code ≥ 1.90，Windows 优先；`package.json` 声明 `extensionKind: ["workspace"]`；Remote/WSL/`vscode.dev` 不在 MVP，README 明示。
- dsh 由用户侧安装维护，扩展永不捆绑 harness；MIT 许可下展示 GUI，README/THIRD_PARTY 标注。
- 项目文件夹 `D:\michael_codes\dsh-vscode`（已创建）。
- 本机已装 dsh（discover 主路径可用），npx 兜底默认关闭。

**工作量估计**：Phase 0+0.5 约 1 个工作段；Phase 1 约 2 个；Phase 1.1 约 0.5 个；Phase 1.5 约 1 个；Phase 2（2A→2D）约 3–4 个；Phase 3 开放。
