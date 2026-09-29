// log.ts: the relay's log, one JSON object per line on standard output.
//
// A log line names what happened and the call it happened to. It never holds
// a header, a body, a token, or a credential, so the log is safe to ship to
// any collector.

export type RelayLogFields = Record<string, string | number | boolean | undefined>;

export type RelayLog = (event: string, fields?: RelayLogFields) => void;

/** Write each event as one JSON line, with the time first. */
export function jsonLog(write: (line: string) => void = (line) => process.stdout.write(line)): RelayLog {
  return (event, fields = {}) => {
    write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
  };
}

/** A path without its query string, which may hold a secret. */
export function logPath(path: string): string {
  const query = path.indexOf("?");
  return query === -1 ? path : path.slice(0, query);
}
