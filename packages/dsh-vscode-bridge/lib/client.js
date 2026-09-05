window.__ModuleLoader__.load({
  id: "dsh-vscode-bridge",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let react = require("react");
    let _deliverables = require("@deepseek-ai/dsh-client-ui-deliverables/client");
    let _runtime = require("@deepseek-ai/dsh-client-runtime/client");

    /** Locale namespace owned by this plugin. */
    const NS = "vscodeBridge";

    const zh = {
      "openInVSCode": "在 VS Code 中打开",
      "openInVSCodeFor": "在 VS Code 中打开 {name}",
      "previewDiffInVSCode": "在 VS Code 中预览变更",
      "previewDiffInVSCodeFor": "在 VS Code 中预览 {name} 的变更",
      "shareEditorContext": "共享编辑器上下文",
      "sharingEditorContext": "正在读取编辑器…",
      "editorSelectionShared": "已共享选区",
      "editorFileShared": "已共享文件位置",
      "retryEditorContext": "重试共享",
      "applyEditInVSCode": "在 VS Code 中审阅并应用",
      "applyingEditInVSCode": "等待 VS Code 确认…",
      "editAppliedInVSCode": "已应用（尚未保存）",
      "editNotAppliedInVSCode": "未应用"
    };
    const en = {
      "openInVSCode": "Open in VS Code",
      "openInVSCodeFor": "Open {name} in VS Code",
      "previewDiffInVSCode": "Preview changes in VS Code",
      "previewDiffInVSCodeFor": "Preview changes to {name} in VS Code",
      "shareEditorContext": "Share editor context",
      "sharingEditorContext": "Reading editor…",
      "editorSelectionShared": "Selection shared",
      "editorFileShared": "File position shared",
      "retryEditorContext": "Retry sharing",
      "applyEditInVSCode": "Review and apply in VS Code",
      "applyingEditInVSCode": "Awaiting VS Code confirmation…",
      "editAppliedInVSCode": "Applied (not saved)",
      "editNotAppliedInVSCode": "Not applied"
    };

    const EDITOR_CONTEXT_REQUEST_TYPE = "dsh:requestEditorContext";
    const EDITOR_CONTEXT_RESPONSE_TYPE = "dsh:editorContext";
    const DIFF_PREVIEW_TYPE = "dsh:previewDiff";
    const APPLY_EDIT_REQUEST_TYPE = "dsh:requestApplyEdit";
    const APPLY_EDIT_RESPONSE_TYPE = "dsh:applyEditResult";
    const EDITOR_CONTEXT_REQUEST_TIMEOUT_MS = 10_000;
    const APPLY_EDIT_REQUEST_TIMEOUT_MS = 125_000;
    const MAX_REQUEST_ID_CHARS = 128;
    const MAX_SESSION_ID_CHARS = 512;
    const MAX_APPLY_FILE_CHARS = 32_768;
    const MAX_APPLY_TEXT_CHARS = 1_048_576;
    const SESSION_HEALTH_CHECK_INTERVAL_MS = 5_000;
    const SESSION_HEALTH_MISMATCH_CONFIRMATIONS = 2;

    class EditorContextBridgeError extends Error {
      constructor(code, message) {
        super(message);
        this.name = "EditorContextBridgeError";
        this.code = code;
      }
    }

    class ApplyEditBridgeError extends Error {
      constructor(code, message) {
        super(message);
        this.name = "ApplyEditBridgeError";
        this.code = code;
      }
    }

    function isRecord(value) {
      return typeof value === "object" && value !== null && !Array.isArray(value);
    }

    function validOpaqueId(value, maxLength) {
      return typeof value === "string" &&
        value.length > 0 &&
        value.length <= maxLength &&
        value.trim() === value &&
        !/[\u0000-\u001f\u007f]/u.test(value);
    }

    function isApplyEditProposal(value) {
      return isRecord(value) &&
        Object.keys(value).length === 6 &&
        value.version === 1 &&
        validOpaqueId(value.requestId, MAX_REQUEST_ID_CHARS) &&
        typeof value.file === "string" &&
        value.file.length > 0 &&
        value.file.length <= MAX_APPLY_FILE_CHARS &&
        value.file.trim() === value.file &&
        !/[\u0000-\u001f\u007f]/u.test(value.file) &&
        typeof value.beforeSha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(value.beforeSha256) &&
        typeof value.beforeText === "string" &&
        typeof value.afterText === "string" &&
        value.beforeText.length <= MAX_APPLY_TEXT_CHARS &&
        value.afterText.length <= MAX_APPLY_TEXT_CHARS &&
        !value.beforeText.includes("\0") &&
        !value.afterText.includes("\0") &&
        value.beforeText !== value.afterText;
    }

    /** Correlate one Host proposal with the native VS Code apply result. */
    function createApplyEditRequester(options = {}) {
      const currentWindow = options.windowObject ?? window;
      const parentWindow = options.parentWindow ?? currentWindow.parent;
      const timeoutMs = options.timeoutMs ?? APPLY_EDIT_REQUEST_TIMEOUT_MS;
      const scheduleTimeout = options.setTimeout ?? currentWindow.setTimeout.bind(currentWindow);
      const cancelTimeout = options.clearTimeout ?? currentWindow.clearTimeout.bind(currentWindow);
      const pending = new Map();
      let disposed = false;

      const rejectPending = (requestId, error) => {
        const request = pending.get(requestId);
        if (request === undefined) return;
        pending.delete(requestId);
        cancelTimeout(request.timer);
        request.reject(error);
      };
      const onMessage = (event) => {
        if (event.source !== parentWindow || !isRecord(event.data)) return;
        const data = event.data;
        if (
          data.type !== APPLY_EDIT_RESPONSE_TYPE ||
          !validOpaqueId(data.requestId, MAX_REQUEST_ID_CHARS) ||
          !validOpaqueId(data.sessionId, MAX_SESSION_ID_CHARS)
        ) return;
        const request = pending.get(data.requestId);
        if (request === undefined || request.sessionId !== data.sessionId) return;

        if (
          data.ok === true &&
          typeof data.documentVersion === "number" &&
          Number.isInteger(data.documentVersion) &&
          data.documentVersion >= 0
        ) {
          pending.delete(data.requestId);
          cancelTimeout(request.timer);
          request.resolve({ documentVersion: data.documentVersion });
          return;
        }
        if (
          data.ok === false &&
          isRecord(data.error) &&
          typeof data.error.code === "string" &&
          typeof data.error.message === "string"
        ) {
          rejectPending(
            data.requestId,
            new ApplyEditBridgeError(data.error.code, data.error.message),
          );
        }
      };
      currentWindow.addEventListener("message", onMessage);

      return {
        request(sessionId, proposal) {
          if (disposed) return Promise.reject(new ApplyEditBridgeError(
            "BRIDGE_DISPOSED",
            "The VS Code apply-edit bridge is no longer available.",
          ));
          if (parentWindow === currentWindow) return Promise.reject(new ApplyEditBridgeError(
            "NOT_EMBEDDED",
            "Open DeepSeek Harness inside VS Code to apply this proposal.",
          ));
          if (!validOpaqueId(sessionId, MAX_SESSION_ID_CHARS)) {
            return Promise.reject(new ApplyEditBridgeError(
              "INVALID_SESSION_ID",
              "A valid DSH session is required before applying an edit.",
            ));
          }
          if (!isApplyEditProposal(proposal)) return Promise.reject(new ApplyEditBridgeError(
            "INVALID_REQUEST",
            "The DSH edit proposal is malformed or too large.",
          ));
          if (pending.has(proposal.requestId)) return Promise.reject(new ApplyEditBridgeError(
            "DUPLICATE_REQUEST",
            "This edit proposal is already awaiting VS Code.",
          ));

          return new Promise((resolve, reject) => {
            const timer = scheduleTimeout(() => {
              rejectPending(proposal.requestId, new ApplyEditBridgeError(
                "APPLY_EDIT_TIMEOUT",
                "VS Code did not finish the edit confirmation in time.",
              ));
            }, timeoutMs);
            pending.set(proposal.requestId, { sessionId, resolve, reject, timer });
            try {
              parentWindow.postMessage({
                type: APPLY_EDIT_REQUEST_TYPE,
                version: proposal.version,
                requestId: proposal.requestId,
                sessionId,
                file: proposal.file,
                beforeSha256: proposal.beforeSha256,
                beforeText: proposal.beforeText,
                afterText: proposal.afterText,
              }, "*");
            } catch {
              rejectPending(proposal.requestId, new ApplyEditBridgeError(
                "APPLY_EDIT_SEND_FAILED",
                "The edit proposal could not be sent to VS Code.",
              ));
            }
          });
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          currentWindow.removeEventListener("message", onMessage);
          for (const requestId of [...pending.keys()]) {
            rejectPending(requestId, new ApplyEditBridgeError(
              "BRIDGE_DISPOSED",
              "The VS Code apply-edit bridge was closed.",
            ));
          }
        },
      };
    }

    /**
     * Correlates one explicit editor-context request with the response relayed
     * by the VS Code parent webview. UI wiring is intentionally kept outside
     * this transport so it can be tested independently of DSH React slots.
     */
    function createEditorContextRequester(options = {}) {
      const currentWindow = options.windowObject ?? window;
      const parentWindow = options.parentWindow ?? currentWindow.parent;
      const timeoutMs = options.timeoutMs ?? EDITOR_CONTEXT_REQUEST_TIMEOUT_MS;
      const createRequestId = options.createRequestId ?? (() => currentWindow.crypto.randomUUID());
      const scheduleTimeout = options.setTimeout ?? currentWindow.setTimeout.bind(currentWindow);
      const cancelTimeout = options.clearTimeout ?? currentWindow.clearTimeout.bind(currentWindow);
      const pending = new Map();
      let disposed = false;

      const rejectPending = (requestId, error) => {
        const request = pending.get(requestId);
        if (request === undefined) return;
        pending.delete(requestId);
        cancelTimeout(request.timer);
        request.reject(error);
      };

      const onMessage = (event) => {
        if (event.source !== parentWindow || !isRecord(event.data)) return;
        const data = event.data;
        if (
          data.type !== EDITOR_CONTEXT_RESPONSE_TYPE ||
          !validOpaqueId(data.requestId, MAX_REQUEST_ID_CHARS) ||
          !validOpaqueId(data.sessionId, MAX_SESSION_ID_CHARS)
        ) return;

        const request = pending.get(data.requestId);
        if (request === undefined || request.sessionId !== data.sessionId) return;

        if (data.ok === true && isRecord(data.context)) {
          pending.delete(data.requestId);
          cancelTimeout(request.timer);
          request.resolve(data.context);
          return;
        }
        if (
          data.ok === false &&
          isRecord(data.error) &&
          typeof data.error.code === "string" &&
          typeof data.error.message === "string"
        ) {
          rejectPending(
            data.requestId,
            new EditorContextBridgeError(data.error.code, data.error.message),
          );
        }
      };

      currentWindow.addEventListener("message", onMessage);

      return {
        request(sessionId) {
          if (disposed) {
            return Promise.reject(new EditorContextBridgeError(
              "BRIDGE_DISPOSED",
              "The VS Code editor-context bridge is no longer available.",
            ));
          }
          if (parentWindow === currentWindow) {
            return Promise.reject(new EditorContextBridgeError(
              "NOT_EMBEDDED",
              "Open DeepSeek Harness inside VS Code to share editor context.",
            ));
          }
          if (!validOpaqueId(sessionId, MAX_SESSION_ID_CHARS)) {
            return Promise.reject(new EditorContextBridgeError(
              "INVALID_SESSION_ID",
              "A valid DSH session is required before sharing editor context.",
            ));
          }

          const requestId = createRequestId();
          if (!validOpaqueId(requestId, MAX_REQUEST_ID_CHARS) || pending.has(requestId)) {
            return Promise.reject(new EditorContextBridgeError(
              "INVALID_REQUEST_ID",
              "VS Code editor-context request ID generation failed.",
            ));
          }

          return new Promise((resolve, reject) => {
            const timer = scheduleTimeout(() => {
              rejectPending(requestId, new EditorContextBridgeError(
                "EDITOR_CONTEXT_TIMEOUT",
                "VS Code did not return editor context in time.",
              ));
            }, timeoutMs);
            pending.set(requestId, { sessionId, resolve, reject, timer });
            try {
              parentWindow.postMessage({
                type: EDITOR_CONTEXT_REQUEST_TYPE,
                requestId,
                sessionId,
              }, "*");
            } catch {
              rejectPending(requestId, new EditorContextBridgeError(
                "EDITOR_CONTEXT_SEND_FAILED",
                "The editor-context request could not be sent to VS Code.",
              ));
            }
          });
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          currentWindow.removeEventListener("message", onMessage);
          for (const requestId of [...pending.keys()]) {
            rejectPending(requestId, new EditorContextBridgeError(
              "BRIDGE_DISPOSED",
              "The VS Code editor-context bridge was closed.",
            ));
          }
        },
      };
    }

    /** Request one snapshot, then address the exact originating DSH session. */
    async function shareEditorContextWithSession(requester, sessionId, sessionForId) {
      if (sessionForId(sessionId) === undefined) {
        throw new EditorContextBridgeError(
          "SESSION_UNAVAILABLE",
          "The selected DSH session is no longer available.",
        );
      }

      const context = await requester.request(sessionId);
      const session = sessionForId(sessionId);
      if (session === undefined) {
        throw new EditorContextBridgeError(
          "SESSION_UNAVAILABLE",
          "The selected DSH session closed before editor context could be shared.",
        );
      }

      let payload;
      try {
        payload = JSON.stringify(context);
      } catch {
        throw new EditorContextBridgeError(
          "EDITOR_CONTEXT_SERIALIZE_FAILED",
          "The VS Code editor context could not be serialized.",
        );
      }
      const result = await session.command(`/vscode-context ${payload}`);
      if (isRecord(result) && result.ok === false && isRecord(result.error)) {
        const code = typeof result.error.code === "string"
          ? result.error.code
          : "EDITOR_CONTEXT_COMMAND_FAILED";
        const message = typeof result.error.message === "string"
          ? result.error.message
          : "DSH could not execute the VS Code editor-context command.";
        throw new EditorContextBridgeError(code, message);
      }
      if (!isRecord(result) || result.ok !== true || !isRecord(result.value)) {
        throw new EditorContextBridgeError(
          "EDITOR_CONTEXT_COMMAND_FAILED",
          "DSH returned an invalid editor-context command response.",
        );
      }
      if (result.value.matched !== true) {
        throw new EditorContextBridgeError(
          "VSCODE_CONTEXT_COMMAND_UNAVAILABLE",
          "The DSH VS Code context command is not installed in this session.",
        );
      }
      return { kind: isRecord(context.selection) ? "selection" : "file" };
    }

    const contextButtonStyle = {
      height: "24px",
      padding: "0 8px",
      border: "1px solid currentColor",
      borderRadius: "6px",
      background: "transparent",
      color: "inherit",
      font: "inherit",
      fontSize: "12px",
      lineHeight: "22px",
      whiteSpace: "nowrap"
    };

    /** Small explicit-share control in the composer's left tool row. */
    function VSCodeEditorContextButton({ shareEditorContext, t }) {
      const [state, setState] = react.useState({ phase: "idle" });
      if (window.parent === window) return null;

      const run = async () => {
        if (state.phase === "pending") return;
        setState({ phase: "pending" });
        try {
          const shared = await shareEditorContext();
          setState({ phase: "success", kind: shared.kind });
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : "VS Code editor context could not be shared.";
          setState({ phase: "error", message });
        }
      };

      const label = state.phase === "pending"
        ? t("sharingEditorContext")
        : state.phase === "success"
          ? t(state.kind === "selection" ? "editorSelectionShared" : "editorFileShared")
          : state.phase === "error"
            ? t("retryEditorContext")
            : t("shareEditorContext");
      return react.createElement("button", {
        type: "button",
        "data-dsh-vscode-context": "",
        "data-state": state.phase,
        "aria-label": label,
        "aria-live": "polite",
        title: state.phase === "error" ? state.message : label,
        disabled: state.phase === "pending",
        style: {
          ...contextButtonStyle,
          cursor: state.phase === "pending" ? "wait" : "pointer",
          opacity: state.phase === "pending" ? 0.65 : 0.85,
        },
        onMouseDown: (event) => event.preventDefault(),
        onClick: run,
      }, label);
    }

    function basename(filePath) {
      const at = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
      return at === -1 ? filePath : filePath.slice(at + 1);
    }

    function isFileDiff(value) {
      return isRecord(value) &&
        typeof value.path === "string" &&
        value.path.length > 0 &&
        (value.oldText === null || typeof value.oldText === "string") &&
        typeof value.newText === "string";
    }

    /**
     * Turn-local applied diff accumulator. Result views are authoritative: they
     * carry the persisted before/after hunks produced after the mutation
     * actually succeeds, unlike the call-time intent.
     */
    const diffPreviewsDefinition = {
      kind: "dsh-vscode-diff-previews",
      match: (event) => {
        if (event.type === "turn/start") return {
          id: String(event.data.turn),
          role: "start",
        };
        if (event.type === "tool/result" && _runtime.isAppendSurfaceEvent(event)) return {
          id: String(event.data.turn),
          role: "update",
        };
        return null;
      },
      start: (_context, match) => {
        if (match.event.type !== "turn/start") {
          throw new Error("dsh-vscode diff previews require turn/start");
        }
        return { turn: match.event.data.turn, changes: [] };
      },
      update: (context, match) => {
        if (match.event.type !== "tool/result") return context.state;
        if (match.event.data.message.content[0]?.isError === true) return context.state;
        const view = match.view?.for === "result" ? match.view.view : null;
        if (!isRecord(view) || view.card !== "diff" || !Array.isArray(view.diffs)) {
          return context.state;
        }
        const additions = view.diffs.filter(isFileDiff).map((diff) => ({
          seq: match.event.seq,
          path: diff.path,
          oldText: diff.oldText,
          newText: diff.newText,
        }));
        return additions.length === 0 ? context.state : {
          ...context.state,
          changes: [...context.state.changes, ...additions],
        };
      },
      buildLocationData: (context, scope) =>
        scope !== "turn" || context.state === undefined
          ? null
          : {
              kind: "turn",
              turn: context.state.turn,
              key: "dsh-vscode-diff-previews",
              value: { changes: context.state.changes },
            },
    };

    /** Group applied hunks by file and exclude mutations after the closing message. */
    function diffPreviewsForClosing(data, seq = Number.POSITIVE_INFINITY) {
      if (!isRecord(data) || !Array.isArray(data.changes)) return [];
      const byPath = new Map();
      for (const change of data.changes) {
        if (
          !isRecord(change) ||
          typeof change.seq !== "number" ||
          change.seq > seq ||
          !isFileDiff(change)
        ) continue;
        let preview = byPath.get(change.path);
        if (preview === undefined) {
          preview = { path: change.path, diffs: [] };
          byPath.set(change.path, preview);
        }
        preview.diffs.push({ oldText: change.oldText, newText: change.newText });
      }
      return [...byPath.values()];
    }

    /** Persist successful proposal-tool metadata for the closing turn UI. */
    const applyProposalsDefinition = {
      kind: "dsh-vscode-apply-proposals",
      match: (event) => {
        if (event.type === "turn/start") return {
          id: String(event.data.turn),
          role: "start",
        };
        if (event.type === "tool/result" && _runtime.isAppendSurfaceEvent(event)) return {
          id: String(event.data.turn),
          role: "update",
        };
        return null;
      },
      start: (_context, match) => {
        if (match.event.type !== "turn/start") {
          throw new Error("dsh-vscode apply proposals require turn/start");
        }
        return { turn: match.event.data.turn, proposals: [] };
      },
      update: (context, match) => {
        if (match.event.type !== "tool/result") return context.state;
        if (match.event.data.message.content[0]?.isError === true) return context.state;
        const view = match.view?.for === "result" ? match.view.view : null;
        const proposal = isRecord(view) ? view.dshVscodeApplyProposal : undefined;
        if (!isApplyEditProposal(proposal)) return context.state;
        return {
          ...context.state,
          proposals: [...context.state.proposals, {
            seq: match.event.seq,
            version: proposal.version,
            requestId: proposal.requestId,
            file: proposal.file,
            beforeSha256: proposal.beforeSha256,
            beforeText: proposal.beforeText,
            afterText: proposal.afterText,
          }],
        };
      },
      buildLocationData: (context, scope) =>
        scope !== "turn" || context.state === undefined
          ? null
          : {
              kind: "turn",
              turn: context.state.turn,
              key: "dsh-vscode-apply-proposals",
              value: { proposals: context.state.proposals },
            },
    };

    function applyProposalsForClosing(data, seq = Number.POSITIVE_INFINITY) {
      if (!isRecord(data) || !Array.isArray(data.proposals)) return [];
      const proposals = [];
      for (const candidate of data.proposals) {
        if (!isRecord(candidate) || typeof candidate.seq !== "number" || candidate.seq > seq) {
          continue;
        }
        const proposal = {
          version: candidate.version,
          requestId: candidate.requestId,
          file: candidate.file,
          beforeSha256: candidate.beforeSha256,
          beforeText: candidate.beforeText,
          afterText: candidate.afterText,
        };
        if (isApplyEditProposal(proposal)) proposals.push(proposal);
      }
      return proposals;
    }

    /** Send one strictly shaped, read-only diff request to the embedding parent. */
    function postDiffPreview(parentWindow, cwd, preview) {
      parentWindow.postMessage({
        type: DIFF_PREVIEW_TYPE,
        file: _runtime.resolveWorkspacePath(cwd, preview.path),
        diffs: preview.diffs.map((diff) => ({
          oldText: diff.oldText,
          newText: diff.newText,
        })),
      }, "*");
    }

    /**
     * Detect a lost idle transition in the embedded DSH client. The Host list
     * is an independent authoritative read: requiring the same mismatch twice
     * avoids refreshing during an ordinary turn-completion race. A reload is
     * deliberately reserved for the confirmed mismatch because it rebuilds
     * both the history window and the server-owned queue mirror.
     */
    function createSessionHealthWatchdog(options) {
      const currentWindow = options.windowObject ?? window;
      const intervalMs = options.intervalMs ?? SESSION_HEALTH_CHECK_INTERVAL_MS;
      const confirmations = options.confirmations ?? SESSION_HEALTH_MISMATCH_CONFIRMATIONS;
      const scheduleTimeout = options.setTimeout ?? currentWindow.setTimeout.bind(currentWindow);
      const cancelTimeout = options.clearTimeout ?? currentWindow.clearTimeout.bind(currentWindow);
      const reload = options.reload ?? (() => currentWindow.location.reload());
      const isVisible = options.isVisible ?? (() => currentWindow.document?.visibilityState !== "hidden");
      let timer;
      let disposed = false;
      let checking = false;
      let mismatchSessionId;
      let mismatchCount = 0;

      const resetMismatch = () => {
        mismatchSessionId = undefined;
        mismatchCount = 0;
      };
      const schedule = () => {
        if (!disposed) timer = scheduleTimeout(check, intervalMs);
      };
      const check = async () => {
        if (disposed || checking) return;
        checking = true;
        try {
          if (!isVisible()) {
            resetMismatch();
            return;
          }
          const before = options.sessions.list.getSnapshot();
          const sessionId = before.current;
          const local = sessionId === undefined
            ? undefined
            : options.sessions.binding(sessionId)?.session?.getSnapshot?.();
          if (sessionId === undefined || local?.running !== true) {
            resetMismatch();
            return;
          }

          const response = await options.api.sessions.list({});
          if (!response?.result?.ok) {
            resetMismatch();
            return;
          }
          const after = options.sessions.list.getSnapshot();
          const currentLocal = after.current === sessionId
            ? options.sessions.binding(sessionId)?.session?.getSnapshot?.()
            : undefined;
          const authoritative = response.result.value.items.find(
            (item) => item.sessionId === sessionId,
          );
          if (after.current !== sessionId || currentLocal?.running !== true || authoritative?.running !== false) {
            resetMismatch();
            return;
          }

          if (mismatchSessionId === sessionId) mismatchCount += 1;
          else {
            mismatchSessionId = sessionId;
            mismatchCount = 1;
          }
          if (mismatchCount >= confirmations) {
            disposed = true;
            if (timer !== undefined) cancelTimeout(timer);
            console.warn(`[dsh-vscode-bridge] repairing stale running state for ${sessionId}`);
            reload();
          }
        } catch {
          resetMismatch();
        } finally {
          checking = false;
          schedule();
        }
      };

      // The bridge must never alter a standalone browser tab.
      if (currentWindow.parent !== currentWindow) schedule();
      return {
        dispose() {
          disposed = true;
          if (timer !== undefined) cancelTimeout(timer);
          resetMismatch();
        },
      };
    }

    /** Required services on the client root context. */
    const inject = [
      "slots",
      "locale",
      "connection",
      "sessions",
      "conversationEvents"
    ];

    /**
     * Claim the turn-tail chain when the closing turn produced files. This
     * mirrors the deliverables selector so our combined row can run before the
     * stock ProducedFiles entry (priority -1) without changing its behavior.
     */
    function selectProducedFiles(owner) {
      const paths = _deliverables.producedForClosing(
        owner.turn.data.get("deliverables"),
        owner.seq,
      );
      if (paths.length === 0) return null;
      const previews = diffPreviewsForClosing(
        owner.turn.data.get("dsh-vscode-diff-previews"),
        owner.seq,
      ).filter((preview) => paths.includes(preview.path));
      return { paths, previews };
    }

    function selectApplyProposals(owner) {
      const proposals = applyProposalsForClosing(
        owner.turn.data.get("dsh-vscode-apply-proposals"),
        owner.seq,
      );
      return proposals.length === 0 ? null : proposals;
    }

    function VSCodeApplyButtons({ matched, requestApplyEdit, t }) {
      const [states, setStates] = react.useState({});
      if (window.parent === window) return null;

      const run = async (proposal) => {
        if (states[proposal.requestId] !== undefined) return;
        setStates((current) => ({ ...current, [proposal.requestId]: { phase: "pending" } }));
        try {
          await requestApplyEdit(proposal);
          setStates((current) => ({ ...current, [proposal.requestId]: { phase: "success" } }));
        } catch (error) {
          const message = error instanceof Error ? error.message : "VS Code did not apply the edit.";
          setStates((current) => ({
            ...current,
            [proposal.requestId]: { phase: "error", message },
          }));
        }
      };

      return react.createElement(
        "div",
        { className: "dsh-vscode-bridge-apply-actions" },
        matched.map((proposal) => {
          const state = states[proposal.requestId] ?? { phase: "idle" };
          const label = state.phase === "pending"
            ? t("applyingEditInVSCode")
            : state.phase === "success"
              ? t("editAppliedInVSCode")
              : state.phase === "error"
                ? t("editNotAppliedInVSCode")
                : t("applyEditInVSCode");
          return react.createElement("button", {
            key: proposal.requestId,
            type: "button",
            "data-dsh-vscode-apply": "",
            "data-state": state.phase,
            "aria-label": `${label}: ${proposal.file}`,
            "aria-live": "polite",
            title: state.phase === "error" ? state.message : proposal.file,
            disabled: state.phase !== "idle",
            style: {
              ...contextButtonStyle,
              cursor: state.phase === "idle" ? "pointer" : "default",
              opacity: state.phase === "idle" ? 0.85 : 0.65,
            },
            onClick: () => run(proposal),
          }, `${label}: ${basename(proposal.file)}`);
        }),
      );
    }

    /**
     * Renders the stock produced-files row plus an "Open in VS Code" action
     * row. The buttons post absolute paths to the embedding webview parent;
     * the VS Code extension receives them and calls showTextDocument.
     */
    function VSCodeOpenButtons({
      matched: { paths, previews },
      openFile,
      isLoopback,
      useHostDescription,
      useSessions,
      sessionId,
      t,
    }) {
      const cwd = useSessions((s) => (sessionId === undefined ? undefined : s.byId[sessionId]?.cwd));
      const absolute = (filePath) => _runtime.resolveWorkspacePath(cwd, filePath);
      // The VS Code bridge only exists when the SPA is framed inside the
      // extension's webview. In a standalone browser tab, keep the stock UI.
      const embedded = window.parent !== window;
      const openInVSCode = (filePath) => {
        window.parent.postMessage(
          { type: "dsh:openInEditor", file: absolute(filePath) },
          "*",
        );
      };
      const previewInVSCode = (preview) => {
        postDiffPreview(window.parent, cwd, preview);
      };

      return react.createElement(
        "div",
        { className: "dsh-vscode-bridge-open" },
        react.createElement(
          _deliverables.ProducedFiles,
          {
            matched: paths,
            openFile,
            isLoopback,
            useHostDescription,
            t,
          },
        ),
        embedded &&
          react.createElement(
            "div",
            { className: "dsh-vscode-bridge-open-actions" },
            react.createElement(
              "span",
              { className: "dsh-vscode-bridge-open-label" },
              t("openInVSCode"),
            ),
            paths.map((filePath) =>
              react.createElement(
                "button",
                {
                  key: filePath,
                  type: "button",
                  title: absolute(filePath),
                  "aria-label": t("openInVSCodeFor", { name: filePath }),
                  onClick: () => openInVSCode(filePath),
                },
                basename(filePath),
              ),
            ),
          ),
        embedded && previews.length > 0 &&
          react.createElement(
            "div",
            { className: "dsh-vscode-bridge-diff-actions" },
            react.createElement(
              "span",
              { className: "dsh-vscode-bridge-diff-label" },
              t("previewDiffInVSCode"),
            ),
            previews.map((preview) =>
              react.createElement(
                "button",
                {
                  key: preview.path,
                  type: "button",
                  title: absolute(preview.path),
                  "data-dsh-vscode-diff": "",
                  "aria-label": t("previewDiffInVSCodeFor", { name: preview.path }),
                  onClick: () => previewInVSCode(preview),
                },
                basename(preview.path),
              ),
            ),
          ),
      );
    }

    function apply(ctx) {
      const connection = ctx.get("connection");
      const sessions = ctx.sessions;
      const contextRequester = createEditorContextRequester();
      const applyEditRequester = createApplyEditRequester();
      const sessionHealthWatchdog = createSessionHealthWatchdog({
        windowObject: window,
        api: connection.api,
        sessions,
      });
      ctx.conversationEvents.register(diffPreviewsDefinition);
      ctx.conversationEvents.register(applyProposalsDefinition);
      ctx.effect(
        () => () => {
          contextRequester.dispose();
          applyEditRequester.dispose();
          sessionHealthWatchdog.dispose();
        },
        "dsh-vscode-bridge: VS Code request bridges",
      );
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-vscode-bridge: dictionaries");
      ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({
        name: "conversation.chat.turnTail",
        priority: -1,
        select: selectProducedFiles,
        locale: NS,
        inject: () => ({
          isLoopback: connection.isLoopback,
          hooks: { hostDescription: connection.hostDescription },
        }),
      }, VSCodeOpenButtons));
      ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
        name: "conversation.input.left",
        id: "dsh-vscode-editor-context",
        order: 50,
        locale: NS,
        inject: (sessionId) => ({
          shareEditorContext: () => shareEditorContextWithSession(
            contextRequester,
            sessionId,
            (id) => sessions.binding(id)?.session,
          ),
        }),
      }, VSCodeEditorContextButton));
      ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({
        name: "conversation.chat.turnTail",
        priority: -2,
        select: selectApplyProposals,
        locale: NS,
        inject: (sessionId) => ({
          requestApplyEdit: (proposal) => {
            const cwd = sessions.binding(sessionId)?.session?.cwd;
            return applyEditRequester.request(sessionId, {
              ...proposal,
              file: _runtime.resolveWorkspacePath(cwd, proposal.file),
            });
          },
        }),
      }, VSCodeApplyButtons));
    }

    exports.apply = apply;
    exports.createEditorContextRequester = createEditorContextRequester;
    exports.EditorContextBridgeError = EditorContextBridgeError;
    exports.shareEditorContextWithSession = shareEditorContextWithSession;
    exports.diffPreviewsDefinition = diffPreviewsDefinition;
    exports.diffPreviewsForClosing = diffPreviewsForClosing;
    exports.postDiffPreview = postDiffPreview;
    exports.VSCodeOpenButtons = VSCodeOpenButtons;
    exports.createApplyEditRequester = createApplyEditRequester;
    exports.ApplyEditBridgeError = ApplyEditBridgeError;
    exports.applyProposalsDefinition = applyProposalsDefinition;
    exports.applyProposalsForClosing = applyProposalsForClosing;
    exports.VSCodeApplyButtons = VSCodeApplyButtons;
    exports.createSessionHealthWatchdog = createSessionHealthWatchdog;
    exports.inject = inject;
    return module.exports;
  },
});
