import * as vscode from 'vscode';
import { LoggerLike } from './types';

/** Output-channel logger; every dsh child log line lands here. */
export class Logger implements LoggerLike {
  private readonly channel: vscode.OutputChannel;

  constructor(name: string) {
    this.channel = vscode.window.createOutputChannel(name);
  }

  log(message: string): void {
    this.channel.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  show(): void {
    this.channel.show();
  }

  dispose(): void {
    this.channel.dispose();
  }
}
