# dsh-vscode-bridge

DSH web profile 插件：在 DSH 的产物文件行追加 **Open in VS Code** 按钮，通过
`window.parent.postMessage` 把文件路径（及可选行号）交给 VS Code 扩展打开。

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

## 卸载

```powershell
dsh plugin --profile web remove -w dsh-vscode-bridge
```

同时把 `cordis.patch.yml` 里对应的 `dsh-vscode-bridge` insert 行删掉。

## 版本兼容

目标 DSH `0.1.0-rc.6`（与扩展 `dsh.pinnedVersion` 一致）。若 DSH 客户端
slot/插件接口变更，`lib/client.js` 需要随上游适配。
