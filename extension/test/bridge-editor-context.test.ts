import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createEditorContextCommand,
  EditorContextSnapshot,
  formatEditorContextForModel,
  MAX_EDITOR_CONTEXT_COMMAND_CHARS,
  MAX_EDITOR_SELECTION_CHARS,
  parseEditorContextCommandInput,
} from '../../packages/dsh-vscode-bridge/lib/editor-context.js';
import { apply as applyHostPlugin, inject as hostInject } from '../../packages/dsh-vscode-bridge/lib/index.js';

function context(): EditorContextSnapshot {
  const file = path.resolve('fixture', 'sample.ts');
  return {
    version: 1,
    file,
    uri: pathToFileURL(file).toString(),
    languageId: 'typescript',
    documentVersion: 7,
    isDirty: true,
    cursor: { line: 5, character: 3 },
    selection: {
      start: { line: 2, character: 4 },
      end: { line: 3, character: 6 },
      text: 'selected text',
      truncated: false,
    },
  };
}

describe('parseEditorContextCommandInput', () => {
  it('accepts the exact versioned snapshot and detaches its value', () => {
    const source = context();
    const parsed = parseEditorContextCommandInput(`  ${JSON.stringify(source)}  `);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.deepEqual(parsed.value, source);
      assert.notEqual(parsed.value, source);
      assert.notEqual(parsed.value.cursor, source.cursor);
    }
  });

  it('accepts file-and-cursor context without a selection', () => {
    const source = context();
    const { selection: _selection, ...withoutSelection } = source;
    const parsed = parseEditorContextCommandInput(JSON.stringify(withoutSelection));
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.value.selection, undefined);
  });

  it('rejects malformed, unknown-version, extra-field, and non-file payloads', () => {
    const source = context();
    const cases: Array<[string, RegExp]> = [
      ['', /required/],
      ['not-json', /valid JSON/],
      [JSON.stringify([]), /must be an object/],
      [JSON.stringify({ ...source, version: 2 }), /version must be 1/],
      [JSON.stringify({ ...source, unexpected: true }), /unexpected unexpected/],
      [JSON.stringify({ ...source, file: 'relative.ts' }), /absolute path/],
      [JSON.stringify({ ...source, uri: 'https://example.com/sample.ts' }), /file scheme/],
      [JSON.stringify({ ...source, languageId: '' }), /non-empty/],
      [JSON.stringify({ ...source, documentVersion: -1 }), /documentVersion/],
      [JSON.stringify({ ...source, isDirty: 'yes' }), /isDirty/],
      [JSON.stringify({ ...source, cursor: { line: 0, character: 1 } }), /cursor.line/],
    ];
    for (const [input, reason] of cases) {
      const parsed = parseEditorContextCommandInput(input);
      assert.equal(parsed.ok, false, input);
      if (!parsed.ok) assert.match(parsed.reason, reason);
    }
  });

  it('strictly validates selection shape, ordering, flags, and size', () => {
    const source = context();
    const invalidSelections = [
      { ...source.selection, extra: true },
      { ...source.selection, start: { line: 4, character: 1 }, end: { line: 3, character: 1 } },
      { ...source.selection, text: 'x'.repeat(MAX_EDITOR_SELECTION_CHARS + 1) },
      { ...source.selection, truncated: 'false' },
    ];
    for (const selection of invalidSelections) {
      const parsed = parseEditorContextCommandInput(JSON.stringify({ ...source, selection }));
      assert.equal(parsed.ok, false, JSON.stringify(selection));
    }
  });

  it('rejects oversized command input before JSON parsing', () => {
    const parsed = parseEditorContextCommandInput('x'.repeat(MAX_EDITOR_CONTEXT_COMMAND_CHARS + 1));
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.match(parsed.reason, /too large/);
  });
});

describe('formatEditorContextForModel', () => {
  it('labels the snapshot as explicitly shared data and preserves it as JSON', () => {
    const source = context();
    const text = formatEditorContextForModel(source);
    assert.match(text, /explicitly shared by the user/);
    assert.match(text, /literal data/);
    const jsonStart = text.indexOf('{');
    assert.deepEqual(JSON.parse(text.slice(jsonStart)), source);
  });
});

describe('createEditorContextCommand', () => {
  it('registers a non-recording command that injects without waking the agent', () => {
    const created: unknown[] = [];
    const injected: unknown[] = [];
    const command = createEditorContextCommand((input) => {
      created.push(input);
      return { role: 'user', id: 'message-1', ...(input as object) };
    });
    const agent = {
      inject(message: unknown) {
        injected.push(message);
      },
      followup() {
        throw new Error('followup must not be called');
      },
      steer() {
        throw new Error('steer must not be called');
      },
    };

    assert.equal(command.name, 'vscode-context');
    assert.equal(command.recordInput, false);
    const result = command.handler({ rawInput: JSON.stringify(context()), agent });
    assert.equal(result.kind, 'success');
    assert.match(result.text, /queued for the next model step/);
    assert.equal(created.length, 1);
    assert.equal(injected.length, 1);

    const input = created[0] as {
      content: Array<{ type: string; text: string }>;
      source: { kind: string; plugin: string; form: string; sections: Array<{ name: string; text: string }> };
    };
    assert.equal(input.content[0]?.type, 'text');
    assert.equal(input.source.kind, 'plugin');
    assert.equal(input.source.plugin, 'dsh-vscode-bridge');
    assert.equal(input.source.form, 'snapshot');
    assert.equal(input.source.sections[0]?.text, input.content[0]?.text);
  });

  it('returns a contained error and injects nothing for rejected input', () => {
    let createCalls = 0;
    let injectCalls = 0;
    const command = createEditorContextCommand(() => {
      createCalls += 1;
      return {};
    });
    const result = command.handler({
      rawInput: '{"secret":"must not be echoed"}',
      agent: { inject: () => { injectCalls += 1; } },
    });
    assert.equal(result.kind, 'error');
    assert.doesNotMatch(result.text, /must not be echoed/);
    assert.equal(createCalls, 0);
    assert.equal(injectCalls, 0);
  });

  it('creates a frozen DSH user message without waking the agent by default', () => {
    let message: unknown;
    const command = createEditorContextCommand();
    const result = command.handler({
      rawInput: JSON.stringify(context()),
      agent: { inject: (value) => { message = value; } },
    });
    assert.equal(result.kind, 'success');
    const userMessage = message as {
      role: string;
      id: string;
      content: unknown[];
      source: object;
    };
    assert.equal(userMessage.role, 'user');
    assert.match(userMessage.id, /^[0-9a-f-]{36}$/iu);
    assert.equal(Object.isFrozen(userMessage), true);
    assert.equal(Object.isFrozen(userMessage.content), true);
    assert.equal(Object.isFrozen(userMessage.source), true);
  });
});

describe('bridge host entry', () => {
  it('loads without external package resolution and registers the command', () => {
    let registered: unknown;
    let registeredTool: unknown;
    assert.deepEqual(hostInject, ['commands', 'tools']);
    applyHostPlugin({
      commands: {
        register(command) {
          registered = command;
        },
      },
      tools: {
        register(tool) {
          registeredTool = tool;
        },
      },
    });
    assert.equal((registered as { name?: string }).name, 'vscode-context');
    assert.equal((registeredTool as { name?: string }).name, 'vscode_apply_diff');
  });
});
