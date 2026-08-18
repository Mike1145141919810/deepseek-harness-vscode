# dsh-vscode-bridge

DSH web profile 插件：在 DSH 的产物文件行追加 **Open in VS Code** 按钮，通过
`window.parent.postMessage` 把文件路径（及可选行号）交给 VS Code 扩展打开。

## 安装

需要 `pnpm` 可用（`dsh plugin` 内部转发给 pnpm）。

```powershell
cd D:\michael_codes\dsh-vscode
dsh plugin --profile web add -w "$((Resolve-Path packages\dsh-vscode-bridge).Path -replace '\\','/')"
```

然后把插件挂到 web profile loader：编辑 `~/.dsh/profiles/web/cordis.patch.yml`，
把默认的 `[]` 换成（或追加）：

```yaml
- insert:
    - id: dsh-vscode-bridge
      name: 'dsh-vscode-bridge'
```

安装后重启 VS Code（或执行 `DSH: Restart Server`）。

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
