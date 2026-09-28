// scripted-http.ts: a fake `fetch` for the steering repo tests. It answers by
// method and path, so a test runs the real GitHub and GitLab REST clients
// against the replies it scripted and fails on any call it did not expect.

export interface Reply {
  status: number;
  body?: unknown;
}

export interface Call {
  method: string;
  path: string;
  body: unknown;
}

export function ok(body: unknown, status = 200): Reply {
  return { status, body };
}

export function fail(status: number, message: string): Reply {
  return { status, body: { message } };
}

export const GITHUB_BASE = "https://api.github.com";
export const GITLAB_BASE = "https://gitlab.com/api/v4";

/**
 * A fake `fetch` keyed by `METHOD /path`, with the query kept on the path. A
 * list of replies answers in order and repeats its last one. A request with
 * no reply rejects.
 */
export function server(base: string, routes: Record<string, Reply | Reply[]>) {
  const queues = new Map<string, Reply[]>();
  for (const [key, reply] of Object.entries(routes))
    queues.set(key, Array.isArray(reply) ? [...reply] : [reply]);
  const calls: Call[] = [];
  const fetch = (url: string, init: { method: string; body?: string }) => {
    const path = url.slice(base.length);
    const key = `${init.method} ${path}`;
    calls.push({
      method: init.method,
      path,
      body: init.body === undefined ? undefined : (JSON.parse(init.body) as unknown),
    });
    const queue = queues.get(key);
    const reply = queue !== undefined && queue.length > 1 ? queue.shift() : queue?.[0];
    if (reply === undefined) return Promise.reject(new Error(`No reply scripted for ${key}`));
    const text = reply.body === undefined ? "" : JSON.stringify(reply.body);
    return Promise.resolve({ status: reply.status, text: () => Promise.resolve(text) });
  };
  return {
    fetch,
    calls,
    /** The calls sent to one `METHOD /path`. */
    sent: (key: string) => calls.filter((c) => `${c.method} ${c.path}` === key),
    /** Every call that was not a GET, in order. */
    writes: () => calls.filter((c) => c.method !== "GET"),
  };
}
