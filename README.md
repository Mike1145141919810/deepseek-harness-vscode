# DeepSeek Harness for VS Code

把 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的 Web GUI 嵌入 VS Code（编辑器面板 / 侧边栏）运行。

**Desktop VS Code only · Local Extension Host only · Remote / WSL / vscode.dev unsupported**（扩展声明 `extensionKind: ["workspace"]`，需要本地 Node 环境来拉起并管理 `dsh web` 进程）。

> 可运行性验证步骤与结果记录见 [VERIFICATION.md](./VERIFICATION.md)。

## 工作原理

扩展在你的机器上拉起一个 `dsh web` 服务（强制绑定 `127.0.0.1`，端口由扩展预分配），然后用 Webview 面板内的 iframe 加载它。DSH 前端与后端**零改动**，所有会话、skill、审批、设置页面原样可用。

```
VS Code Extension Host                DSH (你的机器)
─────────────────────                ─────────────────
dsh.open ──► 预分配端口 ──► spawn dsh web --host 127.0.0.1 --port N
WebviewPanel ──iframe──► http://127.0.0.1:N  (SPA + /api + WebSocket)
```

## 前置条件

- 已安装 **dsh**（`dsh` 在 PATH 上，或在设置 `dsh.binPath` 里指向它的 `lib/bin.js`）。
- 桌面版 VS Code ≥ 1.90。
- 本扩展**不捆绑** dsh；也不默认联网下载（`dsh.allowNpxFallback` 默认关闭）。

## 安装（开发 / 本地）

```powershell
cd D:\michael_codes\dsh-vscode\extension
npm install
npm run compile
npx vsce package        # 产出 dsh-vscode-0.1.1.vsix
code --install-extension dsh-vscode-0.1.1.vsix
```

调试：在仓库根目录按 F5（使用 `Run Extension` 配置，自动编译并启动扩展开发宿主）。

## 使用

- 命令面板 `DSH: Open DeepSeek Harness`（或点击状态栏 `DSH`）。打开位置由 `dsh.openIn` 决定：`"panel"` 编辑器区面板、`"sidebar"` 活动栏侧边栏、`"browser"` 系统默认浏览器。
- 活动栏机器人图标就是 DSH 侧边栏：服务未启动时显示 Open 按钮；已启动则直接嵌入完整 GUI（不自动拉起服务）。
- 面板内即为 DSH 完整 GUI；隐藏/切走面板时服务继续运行，会话不中断。
- 多窗口共享同一实例：第二个窗口打开 DSH 时自动复用已运行的服务（不重复拉起）；在附加窗口执行 `Stop Server` 只是断开连接，不会杀掉其他窗口的服务。
- `DSH: Run Task (headless)`：在集成终端里跑一次 `dsh --profile headless "<task>"`，适合不需要 GUI 会话的一次性任务。
- 服务中途崩溃时自动重启一次，面板/侧边栏切换到重连页（带 Retry 按钮）；恢复后 iframe 自动重新加载。
- `DSH: Open in Browser` 用系统默认浏览器打开同一实例。

## 设置（`dsh.*`）

| 设置 | 默认 | 说明 |
|---|---|---|
| `dsh.binPath` | `""` | dsh 的 `lib/bin.js` 或包含它的目录；空 = 自动在 PATH 找 |
| `dsh.openIn` | `"panel"` | `"panel"`（编辑器区面板）、`"sidebar"`（活动栏侧边栏）或 `"browser"`（系统浏览器） |
| `dsh.allowNpxFallback` | `false` | 本地找不到 dsh 时允许用 npx 引导安装（需联网） |
| `dsh.autoStart` | `false` | VS Code 启动时自动拉起服务 |
| `dsh.autoWorkspace` | `true` | 打开 GUI 表面（面板/侧边栏）时自动把 VS Code 当前工作区文件夹注册为 DSH 工作区 |
| `dsh.extraArgs` | `[]` | 附加 dsh 参数；`--host`/`--port`/`--trusted-host` 会被拒绝 |
| `dsh.pinnedVersion` | `"0.1.0-rc.6"` | npx 兜底使用的版本 |

## 故障排查

- **`dsh was not found`**：运行 `DSH: Check Installation` 查看诊断；把 `dsh.binPath` 指向 dsh 的 `lib/bin.js`，例如 `C:\Users\<你>\AppData\Local\npm-cache\_npx\<hash>\node_modules\@deepseek-ai\dsh\lib\bin.js`。
- **`dsh server did not become healthy`**：打开输出面板（`DeepSeek Harness` 通道）看子进程日志。
- **面板空白 / 加载失败**：先试 `DSH: Restart Server`；仍不行把 `dsh.openIn` 改为 `"browser"`。
- 输出通道里有每次实例的 `pid`、端口、启动时间与实例 ID；实例记录持久化到 globalStorage，下次启动会做 stale 检测（旧 PID 已死/端口失效则清记录并告警）。

## 安全

- 服务只绑定 `127.0.0.1`；安全相关参数不允许通过 `extraArgs` 覆盖。
- Webview 的 CSP 仅允许 `http://127.0.0.1:*` 帧，父文档不执行脚本、不加载远程内容。
- 关闭 VS Code / 重载窗口时扩展会结束 dsh 进程树并校验端口释放；异常崩溃场景在下次启动时做 stale 检测并告警。

## MVP 验收清单（人工）

- [x] 活动栏图标可打开面板，GUI 完整加载（含 skill 列表）
- [x] 创建 session、发任务、agent 执行并返回结果
- [x] 审批/提问弹窗可用
- [x] agent 改动文件在资源管理器中可见
- [x] 面板隐藏/重开后会话仍在
- [x] `Stop Server` 后进程列表无残留 dsh 进程（重启后亦然）
- [x] 删除 PATH 里的 dsh 后报错信息可操作
- [ ] 服务中途崩溃后面板显示重连页，自动重启后 iframe 自动恢复
- [ ] 强杀残留 dsh 后下次启动 stale 检测清记录并告警
- [ ] `dsh.openIn: "sidebar"` 时活动栏侧边栏完整加载 GUI，重连页/Retry 正常
- [ ] 多窗口打开 DSH 复用同一实例（第二个窗口不新增 dsh 进程）
- [ ] `DSH: Run Task (headless)` 在集成终端执行一次性任务
- [x] VSIX 打包成功（`npm run package`）

## License

MIT。本扩展展示 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）的 Web GUI，不改动、不捆绑其代码，详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
