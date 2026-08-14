// Minimal logging facade that writes to the console (visible in VS Code's
// Developer Tools / extension host output) and, optionally, to an extra sink
// registered via `setLogSink` (e.g. a `vscode.window.createOutputChannel`).
//
// This module must stay free of any `vscode` import so `git/` modules can use
// it without breaking their unit-testability. The vscode-aware sink is injected
// from `extension.ts` at activation.

/** An extra log destination in addition to the console. */
type LogSink = (message: string) => void;

let sink: LogSink | null = null;

/** Register (or clear, with `null`) the extra log destination. */
export function setLogSink(next: LogSink | null): void {
  sink = next;
}

function format(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function emit(args: unknown[]): void {
  if (!sink) return;
  try {
    sink(args.map(format).join(' '));
  } catch {
    // Never let a logging sink break the underlying git call.
  }
}

export const logger = {
  log(...args: unknown[]): void {
    console.log(...args);
    emit(args);
  },
  warn(...args: unknown[]): void {
    console.warn(...args);
    emit(args);
  },
  error(...args: unknown[]): void {
    console.error(...args);
    emit(args);
  },
};
