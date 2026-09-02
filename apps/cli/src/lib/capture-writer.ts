/**
 * capture-writer.ts — an output seam so CLI command handlers can run either
 * against the real stdout/stderr (the `oxagen <cmd>` one-shot shell path,
 * unchanged) or against an in-memory buffer (the REPL inline-execution path,
 * see repl/cli-bridge.ts).
 *
 * The REPL is an Ink app: nothing may touch `process.stdout` / `console.log`
 * while Ink owns the terminal (raw mode + its own render tree), or the output
 * corrupts the UI. So every CLI command wired into the REPL's inline seam
 * takes an optional `CommandWriter` as its last argument — default is the real
 * process streams, the REPL passes `captureWriter()` instead and folds the
 * accumulated text into a single assistant message.
 */

export interface CommandWriter {
  /** Write a line of normal ("stdout") output. */
  write(line: string): void;
  /** Write a line of error/warning ("stderr") output. */
  writeErr(line: string): void;
}

const newline = (s: string): string => (s.endsWith("\n") ? s : `${s}\n`);

/** The real process streams — used by the `oxagen <cmd>` one-shot CLI path. */
export const stdoutWriter: CommandWriter = {
  write: (line) => void process.stdout.write(newline(line)),
  writeErr: (line) => void process.stderr.write(newline(line)),
};

/**
 * An in-memory accumulator for the REPL's inline capture-execution seam.
 * stdout and stderr are interleaved in call order — good enough for a single
 * assistant-message rendering of a command's output.
 */
export function captureWriter(): {
  writer: CommandWriter;
  output: () => string;
} {
  const lines: string[] = [];
  return {
    writer: {
      write: (line) => {
        lines.push(line);
      },
      writeErr: (line) => {
        lines.push(line);
      },
    },
    output: () => lines.join("\n"),
  };
}
