# DeepSeek Harness for VS Code

把 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的 Web GUI 嵌入 VS Code 编辑器面板或侧边栏运行。

**Desktop VS Code only · Local Extension Host only · Remote / WSL / vscode.dev unsupported**（扩展声明 `extensionKind: ["workspace"]`，需要本地 Node 环境来拉起并管理 `dsh web` 进程）。

## 工作原理

扩展在你的机器上拉起一个 `dsh web` 服务（强制绑定 `127.0.0.1`，端口由扩展预分配），然后用 Webview 面板或侧边栏中的 iframe 加载它。DSH 前端与后端**零改动**，所有会话、skill、审批、设置页面原样可用。

```
VS Code Extension Host                DSH (你的机器)
─────────────────────                ─────────────────
dsh.open ──► 预分配端口 ──► spawn dsh web --host 127.0.0.1 --port N
Panel / Sidebar ─iframe─► http://127.0.0.1:N  (SPA + /api + WebSocket)
```

## 前置条件

- 已安装 **dsh**（`dsh` 在 PATH 上，或在设置 `dsh.binPath` 里指向它的 `lib/bin.js`）。
- 桌面版 VS Code ≥ 1.90。
- 本扩展**不捆绑** dsh；也不默认联网下载（`dsh.allowNpxFallback` 默认关闭）。

## 安装（开发 / 本地）

```powershell
cd deepseek-harness-vscode
npm install --prefix extension
npm run package
code --install-extension extension\dsh-vscode-0.1.1.vsix
```

调试：在仓库根目录按 F5（使用 `Run Extension` 配置，自动编译并启动扩展开发宿主）。

### 启用 Open in VS Code（可选）

打开命令面板并执行 `DSH: Install VS Code Bridge`，确认后选择 **Restart DSH**。桥接包已包含在 VSIX 中；命令会调用 DSH 安装它，并在需要更新 loader 配置时先保留备份。运行 `DSH: Check Installation` 可确认输出为 `bridge: READY`。

> 该功能需要本机可用的 `pnpm`，因为 `dsh plugin` 会调用它。扩展不捆绑 DSH 本体。

## 使用

- 命令面板 `DSH: Open DeepSeek Harness`（或点击状态栏 `DSH`）。打开位置由 `dsh.openIn` 决定。
- 活动栏机器人图标打开 DSH 侧边栏；面板、侧边栏和浏览器共用同一个本地实例。
- 面板内即为 DSH 完整 GUI；隐藏/切走面板时服务继续运行，会话不中断。
- 多个 VS Code 窗口会复用同一 DSH 实例；附加窗口停止时只断开自身连接。
- `DSH: Run Task (headless)` 在集成终端执行一次性任务。
- `DSH: Open in Browser` 用系统默认浏览器打开同一实例。
- 安装桥接插件后，产物文件行的 **Open in VS Code** 可直接打开文件并定位行/列。

## 设置（`dsh.*`）

| 设置 | 默认 | 说明 |
|---|---|---|
| `dsh.binPath` | `""` | dsh 的 `lib/bin.js` 或包含它的目录；空 = 自动在 PATH 找 |
| `dsh.openIn` | `"panel"` | `"panel"`（编辑器区面板）、`"sidebar"`（活动栏侧边栏）或 `"browser"`（系统浏览器） |
| `dsh.allowNpxFallback` | `false` | 本地找不到 dsh 时允许用 npx 引导安装（需联网） |
| `dsh.autoStart` | `false` | VS Code 启动时自动拉起服务 |
| `dsh.autoWorkspace` | `true` | 打开 GUI 表面时自动把 VS Code 当前工作区文件夹注册为 DSH 工作区 |
| `dsh.extraArgs` | `[]` | 附加 dsh 参数；`--host`/`--port`/`--trusted-host` 会被拒绝 |
| `dsh.pinnedVersion` | `"0.1.0-rc.6"` | npx 兜底使用的版本 |

## 故障排查

- **`dsh was not found`**：运行 `DSH: Check Installation` 查看诊断；把 `dsh.binPath` 指向 dsh 的 `lib/bin.js`，例如 `C:\Users\<你>\AppData\Local\npm-cache\_npx\<hash>\node_modules\@deepseek-ai\dsh\lib\bin.js`。
- **`dsh server did not become healthy`**：打开输出面板（`DeepSeek Harness` 通道）看子进程日志。
- **面板空白 / 加载失败**：先试 `DSH: Restart Server`；仍不行把 `dsh.openIn` 改为 `"browser"`。
- **Open in VS Code 不可用**：执行 `DSH: Check Installation`；不是 `bridge: READY` 时运行 `DSH: Install VS Code Bridge`，然后重启 DSH。
- 输出通道里有每次实例的 `pid`、端口、启动时间与实例 ID，方便排查残留进程。

## 安全

- 服务只绑定 `127.0.0.1`；安全相关参数不允许通过 `extraArgs` 覆盖。
- Webview 的 CSP 仅允许 `http://127.0.0.1:*` 帧；父文档只执行带每次渲染 nonce 的本地桥接脚本，不允许远程脚本。
- 关闭 VS Code / 重载窗口时扩展会结束 dsh 进程树；异常崩溃场景在下次启动时做 stale 检测。

## MVP 验收清单（人工）

- [x] 活动栏图标可打开面板，GUI 完整加载（含 skill 列表）
- [x] 创建 session、发任务、agent 执行并返回结果
- [x] 审批/提问弹窗可用
- [x] agent 改动文件在资源管理器中可见
- [x] 面板隐藏/重开后会话仍在
- [x] `Stop Server` 后进程列表无残留 dsh 进程（重启后亦然）
- [x] 删除 PATH 里的 dsh 后报错信息可操作
- [x] sidebar、崩溃重连、stale 检测和跨窗口实例复用
- [x] Phase 2A 桥接包包含在 VSIX，一键安装后端通过隔离环境验证
- [x] VSIX 打包成功（`npm run package`）

## License

MIT。本扩展展示 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）的 Web GUI，不改动、不捆绑其代码，详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
