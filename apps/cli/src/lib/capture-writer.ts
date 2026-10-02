/**
 * capture-writer.ts — an output seam so CLI command handlers can run either
 * against the real stdout/stderr (the `oxagen <cmd>` shell path) or against an
 * in-memory buffer.
 *
 * Every command handler takes an optional `CommandWriter` as its last
 * argument, defaulting to the real process streams. That keeps two things
 * true: a handler's output is assertable in a unit test without patching
 * `process.stdout`, and a caller that owns the terminal itself can collect the
 * text instead of letting the handler write into its render tree.
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
 * Print an error and diverge. The one-shot `oxagen <cmd>` path exits 1. Any
 * other writer means a caller is capturing the output, where `process.exit`
 * would end the caller's whole process, so it throws instead. The message is
 * written to `writer` before either path is taken, so a caller that catches
 * the throw already holds the text.
 */
export function failCommand(
  message: string,
  writer: CommandWriter = stdoutWriter,
): never {
  writer.writeErr(message);
  if (writer === stdoutWriter) process.exit(1);
  throw new Error(message);
}

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
