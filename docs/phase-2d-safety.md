# Phase 2D 写回安全门槛

**状态：已完成。协议/策略层、VS Code 执行层、Webview 通道、DSH Host/client 提案链、安装态真实浏览器以及 VS Code 原生确认/撤销验收均已通过。**

当前已实现 `extension/src/apply-edit.ts`：严格的版本化请求解析、UTF-8 SHA-256 校验、Windows/POSIX 工作区与 canonical path 包含判定、dirty/preimage/document version 前置条件，以及单请求、两分钟过期和 request ID 防重放门禁。该模块不导入 `vscode`、不访问文件系统，也不能修改文件。

`extension/src/apply-edit-vscode.ts` 已实现原生执行流：预览前及确认后重复检查 workspace trust、普通文件、lexical/canonical path、dirty、全文 preimage 和 document version；随后使用 `TextEditor.edit` 建立单一 undo 单元，不调用 `save()`。真实 VS Code 烟测已验证确认应用后磁盘不变、一次 Undo 恢复，以及取消、不可信、工作区外、符号链接逃逸、文件缺失、dirty 和确认期间版本变化均为零写入。

生产入口现已接通：`vscode_apply_diff` Host 工具只生成带 SHA-256 的提案；client 按成功工具结果和关闭序号持久化提案按钮；iframe、父 Webview 与扩展使用 requestId + sessionId 精确关联，父页和扩展分别执行字段/大小校验；扩展结果再按精确 iframe origin 回传。畸形、额外字段和超限输入不会到达原生执行控制器。

Windows 的 `realpath` 可能返回 8.3 短路径；若直接用该 URI 打开，会让 VS Code 为同一文件建立第二个文档并绕过原文档的 dirty 状态。执行层因此只用 canonical path 做身份/包含检查，并按 canonical identity 复用已打开的原 URI；若同一真实文件出现多个文档别名则拒绝写回。

Phase 2D 的首个可交付版本只允许用户在 VS Code 内确认并应用一个已有文本文件的完整替换。DSH Host 只能提出候选编辑，最终校验、确认和写回都由 VS Code 扩展宿主完成。以下约束必须全部实现并通过测试，否则产品继续停留在 Phase 2C 的只读预览。

## 1. 首版范围

- 一次请求只涉及一个已存在的普通文本文件。
- 只接受本地 `file:` URI；拒绝 Remote/WSL、虚拟文档和二进制内容。
- 只允许替换文件内容；不允许创建、删除、移动、重命名文件，也不允许多文件事务。
- `beforeText`、`afterText` 各不超过 1 MiB；拒绝 NUL 字符、空操作和未知字段。
- DSH 的 `vscode_apply_diff` 类工具仅生成提案，禁止直接调用文件系统写入能力。

## 2. 请求协议

写回请求采用严格、版本化的完整文件替换协议：

```ts
type ApplyEditRequest = {
  type: "dsh.requestApplyEdit";
  version: 1;
  requestId: string;
  sessionId: string;
  file: string;
  beforeSha256: string;
  beforeText: string;
  afterText: string;
};
```

- 解析器拒绝额外字段、格式错误、控制字符、超长 ID、非绝对路径和不匹配的 SHA-256。
- `requestId` 与 `sessionId` 必须沿用 Phase 2B/2C 的精确关联规则。
- 同一 `requestId` 只能处理一次；请求最多存活 2 分钟；同时只允许一个待确认请求。
- 摘要用于完整性检查和诊断，授权依据仍是当前文档与 `beforeText` 的逐字相等。

## 3. 工作区与路径校验

每次展示确认前，以及用户确认后、真正写入前，都重新执行以下检查：

1. `vscode.workspace.isTrusted` 必须为 `true`；扩展不主动授予或诱导授予信任。
2. 目标必须属于当前打开的某个 workspace folder。
3. 目标必须已存在且为普通文件。
4. 对 workspace root 和目标同时执行词法包含检查与 `realpath` 规范化检查，拒绝通过符号链接或 junction 逃逸工作区；Windows 比较不区分大小写。
5. `workspace.openTextDocument` 得到的文档必须是本地文本文件，且当前未处于 dirty 状态。
6. 当前文档全文必须与 `beforeText` 完全一致；从预览到应用期间文档版本发生变化也必须拒绝。

这些检查在确认后重复，是为了封闭预览、确认与执行之间的状态变化窗口。

## 4. 用户确认流

1. 校验请求与当前文件状态。
2. 复用 Phase 2C 的内存虚拟文档 provider，打开只读 `vscode.diff` 预览。
3. 弹出 VS Code 模态警告，明确显示 workspace 相对路径、会话标识和变更大小；唯一肯定按钮为 **Apply edit**。
4. 关闭、取消、超时或任何非明确肯定结果都视为拒绝。
5. 用户确认后重新执行第 3 节全部检查，成功后才应用。

确认必须发生在 VS Code 原生 UI 中；iframe 内的按钮只能发起提案，不能代表写入授权。

## 5. 应用、撤销与保存

- 首版使用 `TextEditor.edit` 对全文范围执行一次 `replace`，并设置 `undoStopBefore: true`、`undoStopAfter: true`。
- 一次成功请求必须形成一个普通 VS Code undo 单元；一次 Undo 恢复完整的 `beforeText`。
- 扩展绝不自动调用 `TextDocument.save()`。应用后文档保持 dirty，让用户检查、撤销或自行保存；磁盘内容在用户保存前不得变化。
- 应用失败时不得重试部分写入，也不得降级为直接文件系统写入。

选择 `TextEditor.edit` 而不是首版直接使用 `workspace.applyEdit`，是因为前者能显式控制撤销边界，且首版范围固定为单个已打开的文本编辑器。

## 6. 结果与错误

响应继续绑定原 `requestId` 和 `sessionId`。成功结果包含应用后的 `documentVersion`；失败返回稳定错误码，至少覆盖：

- `WORKSPACE_UNTRUSTED`
- `OUTSIDE_WORKSPACE`
- `SYMLINK_ESCAPE`
- `FILE_NOT_FOUND`
- `UNSUPPORTED_FILE`
- `DIRTY_DOCUMENT`
- `STALE_PREIMAGE`
- `INVALID_REQUEST`
- `REQUEST_EXPIRED`
- `DUPLICATE_REQUEST`
- `USER_CANCELLED`
- `APPLY_FAILED`

错误消息不得包含文件内容或其他敏感上下文。

## 7. 实现前验收门槛

进入可用状态前必须具备：

- 纯单元测试：严格协议解析、大小上限、路径包含与 Windows 大小写、符号链接逃逸判定、过期/重复请求、preimage 与版本检查。**已完成：21 项通过。**
- VS Code 烟测正例：可信工作区内已有文件、preimage 精确匹配；应用后文档 dirty；一次 Undo 恢复原文；显式保存前磁盘字节不变。**已完成。**
- VS Code 烟测反例：不可信工作区、工作区外路径、符号链接逃逸、dirty 文档、过时 preimage、确认后版本变化、用户取消、畸形或超限请求。**已完成。**
- 安装态分层验收：真实 DSH 模块系统渲染并点击提案按钮，严格请求和关联响应通过；真实 VS Code Extension Host 展示 diff/模态确认，验证取消零写入、确认后不自动保存及一次 Undo 恢复。**已完成。**

任一项不能可靠满足时，不注册 Host 写回工具、不暴露写回按钮，并保持 Phase 2C 只读行为。
