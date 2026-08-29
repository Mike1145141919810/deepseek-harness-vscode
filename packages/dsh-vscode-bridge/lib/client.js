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
      "shareEditorContext": "共享编辑器上下文",
      "sharingEditorContext": "正在读取编辑器…",
      "editorSelectionShared": "已共享选区",
      "editorFileShared": "已共享文件位置",
      "retryEditorContext": "重试共享"
    };
    const en = {
      "openInVSCode": "Open in VS Code",
      "openInVSCodeFor": "Open {name} in VS Code",
      "shareEditorContext": "Share editor context",
      "sharingEditorContext": "Reading editor…",
      "editorSelectionShared": "Selection shared",
      "editorFileShared": "File position shared",
      "retryEditorContext": "Retry sharing"
    };

    const EDITOR_CONTEXT_REQUEST_TYPE = "dsh:requestEditorContext";
    const EDITOR_CONTEXT_RESPONSE_TYPE = "dsh:editorContext";
    const EDITOR_CONTEXT_REQUEST_TIMEOUT_MS = 10_000;
    const MAX_REQUEST_ID_CHARS = 128;
    const MAX_SESSION_ID_CHARS = 512;

    class EditorContextBridgeError extends Error {
      constructor(code, message) {
        super(message);
        this.name = "EditorContextBridgeError";
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
        !/[\0\r\n]/u.test(value);
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

    /** Required services on the client root context. */
    const inject = [
      "slots",
      "locale",
      "connection",
      "sessions"
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
      return paths.length === 0 ? null : paths;
    }

    /**
     * Renders the stock produced-files row plus an "Open in VS Code" action
     * row. The buttons post absolute paths to the embedding webview parent;
     * the VS Code extension receives them and calls showTextDocument.
     */
    function VSCodeOpenButtons({
      matched: paths,
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
      );
    }

    function apply(ctx) {
      const connection = ctx.get("connection");
      const sessions = ctx.sessions;
      const contextRequester = createEditorContextRequester();
      ctx.effect(
        () => () => contextRequester.dispose(),
        "dsh-vscode-bridge: editor context requester",
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
    }

    exports.apply = apply;
    exports.createEditorContextRequester = createEditorContextRequester;
    exports.EditorContextBridgeError = EditorContextBridgeError;
    exports.shareEditorContextWithSession = shareEditorContextWithSession;
    exports.inject = inject;
    return module.exports;
  },
});
