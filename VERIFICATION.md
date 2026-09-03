# dsh-vscode 可运行验证

> 本文档用于验证 DeepSeek Harness VS Code 扩展在当前机器上可安装、可激活、可运行，并记录验证结果。任何一次发版/大改动后按本清单复验。

## 环境（2026-08-27 实测基线）

- VS Code：1.123.0（桌面版，本地扩展宿主）
- dsh：全局安装 `@deepseek-ai/dsh@0.1.1-rc.2`（与 `dsh.pinnedVersion` 一致），空 `dsh.binPath` 自动发现
- 用户级设置：`dsh.openIn = "sidebar"`
- 注意：F5 开发宿主不继承 workspace 级 `.vscode/settings.json`，测设置相关项一律用用户级设置

---

## 1. 自动化验证（命令行）

### 1.1 单元 + 集成测试

```powershell
cd D:\michael_codes\dsh-vscode\extension
npm test
```

**通过标准**

- `tsc --noEmit` 无报错
- 集成测试日志含：
  - `[stale] cleared stale dsh instance record ...`
  - `dsh ready at http://127.0.0.1:<port> (pid=... instance=...)`
  - `step: process count returns to baseline`
- `bridge-editor-context.test` 验证 Host 入口无需外部模块解析即可加载，`/vscode-context` 严格拒绝畸形/超限输入，且只调用 `agent.inject`
- `editor-context-bridge.test` 与 `webview-html.test` 验证 requestId/sessionId 关联、结构化响应、iframe source + 精确 origin 校验以及下行禁止 wildcard target
- `bridge-client-editor-context.test` 验证 DSH client 只接受父窗口且 requestId/sessionId 完全匹配的响应，覆盖结构化错误、超时与销毁清理；同时验证上下文按钮的精确会话命令，以及 Phase 2C 只采集成功落地的 Diff、按文件/结束序号分组并发送严格只读消息
- `diff-preview.test` 验证 Diff 消息字段、绝对路径、片段/文本大小边界和内存前后文档构造
- 结尾：`All 18 test file(s) passed.`（126 个测试全绿，含 2 个真实 DSH 集成测试）

> 真实 DSH 集成测试会写入隔离/用户 `DSH_HOME` 并查询进程；受限沙箱中应单独在沙箱外运行 `node --test dist-test/server-manager.integration.test.js`。

### 1.2 真实 VS Code 冒烟测试

```powershell
cd D:\michael_codes\dsh-vscode\extension
npm run test:smoke
```

**通过标准**：`9 passing`，包含：
1. 激活 → `dsh.open`（panel）→ 服务 HTTP 200 → `dsh.stopServer`
2. `dsh.openInEditor` 打开临时文件并定位到指定行/列（Phase 2A 扩展侧验收）
3. Webview 取得焦点后，`dsh.getEditorContext` 仍能读取最后一个本地文件编辑器的选区（Phase 2B 读取层）
4. `dsh.previewDiff` 打开两份只读虚拟文档，并确认不会创建消息中的目标文件（Phase 2C 扩展侧验收）
5. Phase 2D 确认应用后文档保持 dirty、磁盘不变，一次 Undo 精确恢复 preimage
6. Phase 2D 取消确认后文档与磁盘均不变
7. Phase 2D 拒绝不可信、工作区外、符号链接逃逸、dirty、缺失与确认期间版本变化
8. Webview 写回桥返回精确关联的成功结果，并拒绝畸形/超限请求
9. 聚焦 `dsh.sidebarView` 后 WebviewViewProvider 被解析（侧边栏可运行的关键回归）

> 本机运行 smoke 前需要清掉 `ELECTRON_RUN_AS_NODE`（当前会话被扩展宿主置为 `1`，会让 Code.exe 拒绝 VS Code CLI 参数）：`$env:ELECTRON_RUN_AS_NODE=$null; npm run test:smoke`。

### 1.3 Phase 2B/2C/2D 真实浏览器点击

在 DSH 服务启动后执行：

```powershell
cd D:\michael_codes\dsh-vscode\extension
node test/gui-bridge-smoke.js http://127.0.0.1:<当前端口>
```

**通过标准**：真实 DSH GUI 在 iframe 中渲染上下文按钮；脚本点击后输出 `GUI_BUTTON_STATE=success`、`GUI_CONTEXT_REQUEST=received`、`GUI_SESSION_COMMAND=matched`。脚本还从运行中 DSH 的真实模块系统导入安装态 bridge，渲染并点击实际 Diff 与写回 React 按钮；应输出 `GUI_DIFF_REQUEST=received`、`GUI_APPLY_REQUEST=received`、`GUI_APPLY_STATE=success` 及绝对文件路径。父页面只模拟已由 Webview 单测和真实 VS Code smoke 覆盖的 VS Code 中继/确认结果；不调用模型、不改写用户会话或工作区文件。

---

## 2. 人工验证清单

> 前置：在仓库根目录按 F5 启动开发宿主；或先安装 VSIX（见 §3）。输出通道选择 `DeepSeek Harness`。

### A. 正常打开 + 实例记录 ✅

1. `DSH: Open DeepSeek Harness`，面板/侧边栏出现完整 GUI（含 skill 列表）。
2. 记录文件存在且字段齐全：

```powershell
$rec = "$env:APPDATA\Code\User\globalStorage\michael-lee.dsh-vscode\dsh-server.json"
Get-Content $rec
```

**通过**：JSON 有 `instanceId / pid / port / startedAt`，且 `pid` 与输出通道 `dsh ready ... (pid=...)` 一致。

### B. 主动 Stop → 记录删除 + 端口释放 ✅

1. `DSH: Show Server URL` 记下端口。
2. `DSH: Stop Server`。
3. 检查：

```powershell
Get-NetTCPConnection -State Listen -LocalPort <端口> -ErrorAction SilentlyContinue
Test-Path $rec
```

**通过**：端口无监听；`Test-Path $rec` 为 `False`；输出通道无 `[warn] port ... still answers`；不弹重连页。

### C. 崩溃 → 重连页 → 自动重启 → 自动恢复 ✅

1. 从记录文件取 `pid`。
2. `taskkill /PID <pid> /T /F`。
3. 观察：面板/侧边栏变「DSH connection lost」重连页 → 输出通道出现 `restarting once...` → `dsh ready ...`（新 pid/端口）→ GUI 自动恢复。

**通过**：以上 4 步全部自动发生。

### D. Retry 按钮 ✅

1. 临时把用户级 `dsh.binPath` 改为不存在路径。
2. `taskkill /PID <pid> /T /F` → 自动重启失败 → 重连页停留。
3. 点 **Retry connection** → 报错提示（证明按钮生效）。
4. 把 `dsh.binPath` 改回空 → 再点 Retry → GUI 恢复。

### E. stale 检测 ✅

1. 关闭开发宿主后伪造死记录：

```powershell
$dir = "$env:APPDATA\Code\User\globalStorage\michael-lee.dsh-vscode"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
[System.IO.File]::WriteAllText("$dir\dsh-server.json", '{"v":1,"instanceId":"fake-stale","pid":999999999,"port":65000,"startedAt":"2026-01-01T00:00:00.000Z"}')
```

2. 重新 F5 → `DSH: Open DeepSeek Harness`。
3. 输出通道出现 `[stale] cleared stale dsh instance record (pid=999999999 ...; pid is dead)`，随后正常启动，记录被真实实例替换。

### F. 侧边栏（WebviewView）解析 ✅

1. F5 后点活动栏机器人图标。
2. 输出通道必须出现两行：

```
sidebar WebviewViewProvider registered for dsh.sidebarView
sidebar view resolved (visible=true)
```

3. 侧边栏显示占位页（**Open DeepSeek Harness** 按钮）或完整 DSH GUI。

**已知根因**：`contributes.views` 中必须声明 `"type": "webview"`，否则 VS Code 按树视图处理，`registerWebviewViewProvider` 不会触发 `resolveWebviewView`。

### G. Phase 2A：Open in VS Code（需先安装 bridge 插件）

1. 执行 `DSH: Install VS Code Bridge`，在模态确认中选择 **Install**（需要 pnpm）。
2. 安装完成后选择 **Restart DSH**；再执行 `DSH: Check Installation`，确认输出含 `bridge: READY`。
3. 让 agent 创建/修改文件，在产物文件行点击 **Open in VS Code**。
4. 观察：文件在 VS Code 编辑器打开；若消息带行号，光标定位到该行。

**通过标准**：输出通道无 `open in editor failed`；文件出现在编辑器且选中对应位置。

**安装后端自动验收（2026-08-25）**：桥接包随 VSIX 打包；在临时隔离 `DSH_HOME` 中真实调用 DSH/pnpm，依赖落盘、loader 插入、原 patch 备份和最终 `installed` 状态全部通过；临时目录清理后真实 `~/.dsh` 未变化。

### H. Phase 2B：显式共享编辑器上下文（需重新安装 bridge）

1. 执行 `DSH: Install VS Code Bridge` → **Reinstall**，完成后重启 DSH。
2. 在 VS Code 打开一个本地文件，把光标放到目标位置；可选中一段文本验证选区路径。
3. 在对应 DSH 会话输入框左侧工具行点击 **共享编辑器上下文**。
4. 按钮应显示“正在读取编辑器…”→“已共享选区”或“已共享文件位置”；会话流中出现 `/vscode-context` 命令结果。

**通过标准**：上下文只注入点击时绑定的会话；有选区时包含有界选区文本，无选区时不读取全文；空闲会话不会被自动唤醒；没有本地编辑器或 bridge Host 命令时按钮进入可重试错误态。

### I. Phase 2C：只读 Diff 预览（需重新安装 bridge）

1. 让 agent 成功创建或修改文本文件，确认工具结果包含 Diff。
2. 在对应轮次的产物行点击 **在 VS Code 中预览变更**。
3. VS Code 应打开标题为 `DSH Diff: <文件名>` 的比较视图，两侧 URI scheme 均为 `dsh-diff-preview`。
4. 关闭比较视图后确认目标文件未因“预览”被创建或二次修改。

**通过标准**：输出通道出现 `diff preview requested` / `diff preview opened`，无 `diff preview failed`；预览内容来自 DSH 持久化的 `oldText/newText`，最多 200 个片段、单片段 256 KiB、总计 1 MiB，最多保留 20 组内存预览。

### J. Phase 2D：确认后写回（需重新安装 bridge）

1. 让 agent 调用 `vscode_apply_diff`，为工作区内一个已存在且未修改的文本文件生成完整替换提案。
2. 点击 **在 VS Code 中审阅并应用**，确认 VS Code 先显示 Diff，再显示原生模态确认。
3. 首次选择取消，确认编辑器与磁盘均不变；重新生成提案并明确选择 **Apply edit**。
4. 确认编辑器内容已变化且保持未保存状态，磁盘字节仍不变；执行一次 Undo，确认完整恢复原内容。

**通过标准**：只有原生确认能授权写回；确认前后均通过 workspace trust、lexical/canonical path、普通文件、dirty、preimage 与文档版本校验；写回形成一个 Undo 单元且不自动保存。

---

## 3. 安装态验证（VSIX）

```powershell
cd D:\michael_codes\dsh-vscode\extension
npm run package                        # 产出 dsh-vscode-0.2.1.vsix
code --install-extension dsh-vscode-0.2.1.vsix --force
```

安装后：执行 `Developer: Reload Window`（或完全退出并重开 VS Code）→ 点活动栏机器人图标 → 执行 `DSH: Install VS Code Bridge` → 重复 §2 的 A/B/C/E/F/G/H/I/J。扩展安装目录为 `~/.vscode/extensions/michael-lee.dsh-vscode-0.2.1`。

---

## 4. 验证结果记录

| 项 | 结果 | 日期 | 备注 |
|---|---|---|---|
| 自动化测试（19 文件 / 129 测试） | ✅ | 2026-09-03 | 新增嵌入页会话健康检查回归；含 Phase 2D 协议、Host/client、Webview、执行安全门槛及真实 dsh web 集成 2/2 |
| npm run test:smoke（9 passing） | ✅ | 2026-09-02 | 含 Phase 2D 确认/取消、单 Undo、不保存、安全拒绝与 Webview 关联 |
| A 正常打开 + 记录 | ✅ | 2026-08-16 | — |
| B Stop + 端口释放 | ✅ | 2026-08-16 | — |
| C 崩溃自动恢复 | ✅ | 2026-08-16 | — |
| D Retry 按钮 | ✅ | 2026-08-16 | — |
| E stale 检测 | ✅ | 2026-08-16 | — |
| F 侧边栏解析 | ✅ | 2026-08-16 | `type: webview` 修复后 |
| G Phase 2A Open in VS Code | 🟡 | 2026-08-25 | 扩展侧 smoke、插件装载和一键安装后端通过；真实 GUI 点击仍待肉眼复核 |
| Phase 2A VSIX 分发 + 隔离安装 | ✅ | 2026-08-25 | VSIX 内含 bridge；临时 `DSH_HOME` 中真实 DSH/pnpm 安装、备份、loader 和清理全部通过 |
| H Phase 2B 显式共享上下文 | ✅ | 2026-08-29 | 安装态真实 DSH GUI 按钮点击成功；父响应收到，Host `/vscode-context` 匹配，按钮显示“已共享选区” |
| I Phase 2C 只读 Diff | ✅ | 2026-08-29 | 安装态 DSH 模块系统导入真实 bridge，实际 React 按钮渲染/点击成功；父窗口收到绝对路径和 1 个合法片段；扩展 smoke 确认零文件创建 |
| J Phase 2D 确认后写回 | ✅ | 2026-09-02 | 安装态真实 bridge 提案按钮/关联响应通过；VS Code smoke 验证原生确认、取消、单 Undo、零自动保存及安全拒绝 |
| VSIX 打包 + 安装 | ✅ | 2026-09-03 | `dsh-vscode-0.2.1.vsix`，20 文件 / 52.14 KB；本机覆盖安装，DSH web profile bridge 链接同步至 0.2.1 |

---

## 5. 复验时常见问题

- **「没有可提供视图数据的已注册数据提供程序」**：检查 `extension/package.json` 的 `contributes.views` 中 `dsh.sidebarView` 是否有 `"type": "webview"`，并确认输出通道有 `sidebar WebviewViewProvider registered`。
- **`workspace seed failed ... HTTP 404`**：dsh API 路由晚于 HTTP 监听就绪，扩展已内置重试（250ms→500ms→1s），一般会自动恢复；持续 404 则检查 dsh 版本是否异常。
- **输出通道没有 `dsh ready`**：先 `DSH: Check Installation` 看诊断链；确认 `dsh` 在 PATH 或 `dsh.binPath` 有效。
- **点了 Open in VS Code 没反应**：先运行 `DSH: Check Installation`，不是 `bridge: READY` 时执行 `DSH: Install VS Code Bridge`；再 `Developer: Reload Window`，并查看输出通道有没有 `open in editor requested` / `opened in editor` / `open in editor failed`。
- **bridge 重装在 `Test User` 一类含空格用户目录失败**：扩展安装器会为 DSH 0.1.1 的 Windows 内层 pnpm shell 保留字面引号；若仍失败，确认正在运行的是最新 VSIX 后重试。
- **测试时命令挂住**：`showInformationMessage` 无按钮时不要 `await`（扩展内已 fire-and-forget）；自动化环境里活动栏视图可能无法真实可见，侧边栏以人工 F5 为准。
