# dsh-vscode-bridge

DSH web profile 插件：在 DSH 的产物文件行追加 **Open in VS Code** 和只读
**在 VS Code 中预览变更** 按钮，并提供非唤醒的 `/vscode-context` Host 命令，
用于注入用户显式共享的编辑器上下文。

## 安装

推荐通过 DeepSeek Harness VS Code 扩展安装：

1. 在 VS Code 命令面板执行 `DSH: Install VS Code Bridge`。
2. 在模态确认中选择 **Install**（已安装时显示 **Reinstall**）。
3. 安装完成后选择 **Restart DSH**。

桥接包已包含在 VSIX 中。命令会调用 `dsh plugin --profile web add`，确认依赖已落盘后再幂等补齐 loader 条目；需要改写 `cordis.patch.yml` 时会先保留备份，最后重新检测安装状态。执行 `DSH: Check Installation` 应显示 `bridge: READY`。

需要本机可用的 `pnpm`（`dsh plugin` 内部会调用它）。

## 工作原理

- `lib/client.js`：注册 `conversation.chat.turnTail` chain 条目（`priority: -1`），
  复用 `@deepseek-ai/dsh-client-ui-deliverables/client` 的 `ProducedFiles` 与
  `producedForClosing`，在产物行下渲染 “Open in VS Code” 按钮。
- 点击后向父窗口发送 `{ type: 'dsh:openInEditor', file: <absolute path> }`。
- VS Code 扩展 `media/panel.html` 的 nonce 脚本校验消息来源为 `127.0.0.1`，
  转发为 `dsh.openInEditor`；扩展宿主调用 `showTextDocument` 打开文件。
- `lib/index.js`：注册 `/vscode-context <json>`；`lib/editor-context.js` 严格校验
  版本化上下文，将其构造成 `plugin/snapshot` UserMessage 后调用 `agent.inject()`。
  命令设置 `recordInput: false`，不会把原始 JSON 重复写入 command lifecycle，也不会
  调用 `followup`/`steer` 唤醒空闲会话。
- `lib/client.js` 的请求适配器为每次显式共享生成 requestId，以 requestId + sessionId
  关联父 Webview 回传，并处理来源校验、结构化错误、超时与销毁清理。
- 同一 client 插件在 `conversation.input.left` 注册显式共享按钮；取得快照后只向点击时
  绑定的会话调用 `SessionFace.command('/vscode-context <json>')`，不会改变当前输入草稿。
- client 插件通过 `conversationEvents` 只收集成功执行后的 `tool/result` Diff 视图，按
  关闭消息序号和文件分组 `oldText/newText` 上下文片段；点击预览按钮后发送
  `dsh:previewDiff`。扩展严格校验大小和结构，并用内存虚拟文档打开 VS Code 内置 Diff，
  不读取、创建或修改目标文件。

Phase 2B/2C 的代码通路已经接通；重新安装 bridge 并重启 DSH 后，可从会话输入框工具行
显式共享编辑器上下文，并从产物行打开只读 Diff。安装态真实浏览器验收和人工复验步骤见
扩展仓库 `VERIFICATION.md`。

## 卸载

```powershell
dsh plugin --profile web remove -w dsh-vscode-bridge
```

同时把 `cordis.patch.yml` 里对应的 `dsh-vscode-bridge` insert 行删掉。

## 版本兼容

目标 DSH `0.1.1-rc.2`（与扩展 `dsh.pinnedVersion` 一致）。若 DSH 客户端
slot/插件接口变更，`lib/client.js` 需要随上游适配。
