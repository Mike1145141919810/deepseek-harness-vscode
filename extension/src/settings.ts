import * as vscode from 'vscode';
import { DshSettings } from './types';

export { FORBIDDEN_EXTRA_ARGS, forbiddenExtraArgs } from './security';

export function getSettings(): DshSettings {
  const cfg = vscode.workspace.getConfiguration('dsh');
  return {
    binPath: cfg.get<string>('binPath', ''),
    openIn: cfg.get<'panel' | 'browser'>('openIn', 'panel'),
    allowNpxFallback: cfg.get<boolean>('allowNpxFallback', false),
    autoStart: cfg.get<boolean>('autoStart', false),
    autoWorkspace: cfg.get<boolean>('autoWorkspace', true),
    extraArgs: cfg.get<string[]>('extraArgs', []),
    pinnedVersion: cfg.get<string>('pinnedVersion', '0.1.0-rc.6'),
  };
}
