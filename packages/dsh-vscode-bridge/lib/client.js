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
      "openInVSCodeFor": "在 VS Code 中打开 {name}"
    };
    const en = {
      "openInVSCode": "Open in VS Code",
      "openInVSCodeFor": "Open {name} in VS Code"
    };

    function basename(filePath) {
      const at = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
      return at === -1 ? filePath : filePath.slice(at + 1);
    }

    /** Required services on the client root context. */
    const inject = [
      "slots",
      "locale",
      "connection"
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
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
