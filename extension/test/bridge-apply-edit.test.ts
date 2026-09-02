import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  APPLY_EDIT_TOOL_NAME,
  MAX_APPLY_EDIT_TOOL_FILE_CHARS,
  MAX_APPLY_EDIT_TOOL_TEXT_CHARS,
  createApplyEditTool,
  parseApplyEditToolArgs,
} from '../../packages/dsh-vscode-bridge/lib/apply-edit.js';

const valid = {
  file_path: 'src/sample.ts',
  before_text: 'const value = 1;\n',
  after_text: 'const value = 2;\n',
};

describe('vscode_apply_diff host proposal tool', () => {
  it('strictly validates one bounded full-file replacement', () => {
    assert.deepEqual(parseApplyEditToolArgs(valid), { ok: true, value: valid });
    const invalid: unknown[] = [
      null,
      { ...valid, extra: true },
      { ...valid, file_path: '' },
      { ...valid, file_path: ' padded ' },
      { ...valid, file_path: `bad\npath` },
      { ...valid, file_path: 'x'.repeat(MAX_APPLY_EDIT_TOOL_FILE_CHARS + 1) },
      { ...valid, before_text: null },
      { ...valid, after_text: valid.before_text },
      { ...valid, before_text: 'x\0y' },
      { ...valid, after_text: 'x'.repeat(MAX_APPLY_EDIT_TOOL_TEXT_CHARS + 1) },
    ];
    for (const value of invalid) assert.equal(parseApplyEditToolArgs(value).ok, false);
  });

  it('returns a hashed proposal and never receives a filesystem service', async () => {
    const tool = createApplyEditTool({ createRequestId: () => 'proposal-1' });
    assert.equal(tool.name, APPLY_EDIT_TOOL_NAME);
    const proposal = await tool.execute(valid);
    assert.deepEqual(proposal, {
      version: 1,
      requestId: 'proposal-1',
      file: valid.file_path,
      beforeSha256: '8de5c07db8deb3b75dedd9b5bc999669936cea181ae0033c27c4e2071a6e434d',
      beforeText: valid.before_text,
      afterText: valid.after_text,
    });
    assert.match(
      (tool.output as { render(args: unknown, value: unknown): Array<{ text: string }> })
        .render(valid, proposal)[0]!.text,
      /No file was modified/,
    );
  });

  it('publishes the proposal only in completed presentation metadata', async () => {
    const tool = createApplyEditTool({ createRequestId: () => 'proposal-2' });
    const proposal = await tool.execute(valid);
    const meta = (tool.output as { presentationMeta(args: unknown, value: unknown): unknown })
      .presentationMeta(valid, proposal);
    const view = (tool.presentResult as (args: unknown, result: unknown) => unknown)(valid, {
      isError: false,
      content: [],
      meta,
    }) as { dshVscodeApplyProposal?: unknown };
    assert.deepEqual(view.dshVscodeApplyProposal, proposal);
    assert.equal(
      (tool.presentResult as (args: unknown, result: unknown) => unknown)(valid, {
        isError: true,
        content: [],
        meta,
      }),
      undefined,
    );
  });

  it('rejects malformed execution arguments and invalid request IDs', async () => {
    const tool = createApplyEditTool({ createRequestId: () => ' bad ' });
    await assert.rejects(tool.execute({ ...valid, extra: true }), /Invalid vscode_apply_diff/);
    await assert.rejects(tool.execute(valid), /request ID generation failed/);
  });
});
