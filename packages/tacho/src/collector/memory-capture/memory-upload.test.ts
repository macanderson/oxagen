/**
 * The memory upload (`memory-upload.ts`) against a fake control plane: the
 * request it makes, and which answers mark an entry sent.
 */
import { describe, expect, it } from "vitest";
import { digestBytes } from "../../digest";
import type { FetchLike } from "../../host/control-client";
import type { LocalMemoryEntry } from "./memory-reader";
import { createMemoryUpload, MEMORY_UPLOAD_PATH } from "./memory-upload";

const HOST_ENROLLMENT_ID = "tch_0123456789abcdefghjkmn";

const ENTRY: LocalMemoryEntry = {
  harness: "claude-code",
  path: "/home/dev/.claude/projects/-proj/memory/rule.md",
  statement: "Use pnpm.",
  contentDigest: digestBytes("Use pnpm."),
  modifiedAt: "2026-09-20T12:00:00.000Z",
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A control plane that answers each upload with the next status, or throws. */
function plane(answers: Array<number | Error>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    });
    const answer = answers.shift() ?? 200;
    if (answer instanceof Error) throw answer;
    return {
      ok: answer >= 200 && answer < 300,
      status: answer,
      text: async () => "{}",
    };
  };
  return { fetch, calls };
}

function upload(
  fetch: FetchLike,
  host = {
    api_url: "https://api.oxagen.test/",
    api_key: "oxk_host",
    host_enrollment_id: HOST_ENROLLMENT_ID,
  },
) {
  const lines: string[] = [];
  const send = createMemoryUpload({
    host: () => host,
    fetch,
    log: (line) => lines.push(line),
    timeoutMs: 1_000,
  });
  return { send, lines, host };
}

describe("an upload", () => {
  it("posts the host, harness, path, and statement with the host key", async () => {
    const { fetch, calls } = plane([201]);
    const { send, lines } = upload(fetch);
    await expect(send(ENTRY)).resolves.toBeUndefined();
    expect(calls).toEqual([
      {
        url: `https://api.oxagen.test${MEMORY_UPLOAD_PATH}`,
        method: "POST",
        headers: {
          Authorization: "Bearer oxk_host",
          "Content-Type": "application/json",
        },
        // The contract is strict: the digest and the file time stay on
        // the host, where the reader uses them to skip unchanged files.
        body: {
          host_enrollment_id: HOST_ENROLLMENT_ID,
          harness: "claude-code",
          path: ENTRY.path,
          statement: "Use pnpm.",
        },
      },
    ]);
    expect(lines).toEqual([]);
  });

  it("sends the frontmatter's label, summary, and type when the file has them", async () => {
    const { fetch, calls } = plane([200, 200]);
    const { send } = upload(fetch);
    await send({
      ...ENTRY,
      label: "Package manager",
      summary: "Which tool installs packages",
      memoryType: "feedback",
    });
    await send({ ...ENTRY, label: "Package manager" });
    expect(calls.map((call) => call.body)).toEqual([
      {
        host_enrollment_id: HOST_ENROLLMENT_ID,
        harness: "claude-code",
        path: ENTRY.path,
        statement: "Use pnpm.",
        label: "Package manager",
        summary: "Which tool installs packages",
        memory_type: "feedback",
      },
      // The contract is strict, so a field the file lacks is left out.
      {
        host_enrollment_id: HOST_ENROLLMENT_ID,
        harness: "claude-code",
        path: ENTRY.path,
        statement: "Use pnpm.",
        label: "Package manager",
      },
    ]);
  });

  it("reads the host at every upload, so a renewed key is used", async () => {
    const { fetch, calls } = plane([200, 200]);
    const { send, host } = upload(fetch);
    await send(ENTRY);
    host.api_key = "oxk_renewed";
    await send(ENTRY);
    expect(calls.map((call) => call.headers["Authorization"])).toEqual([
      "Bearer oxk_host",
      "Bearer oxk_renewed",
    ]);
  });
});

describe("a failed upload", () => {
  it("rejects at a 404 and logs the missing route once", async () => {
    const { fetch } = plane([404, 404, 404]);
    const { send, lines } = upload(fetch);
    await expect(send(ENTRY)).rejects.toThrow("404");
    await expect(send(ENTRY)).rejects.toThrow("404");
    await expect(send(ENTRY)).rejects.toThrow("404");
    expect(lines).toEqual([
      `memory upload: the control plane has no ${MEMORY_UPLOAD_PATH} route yet; local memories stay unsent until it does`,
    ]);
  });

  it("resolves when the API refuses this entry's content, so it is not sent again", async () => {
    const { fetch } = plane([400, 413, 422]);
    const { send, lines } = upload(fetch);
    await expect(send(ENTRY)).resolves.toBeUndefined();
    await expect(send(ENTRY)).resolves.toBeUndefined();
    await expect(send(ENTRY)).resolves.toBeUndefined();
    expect(lines).toEqual([
      `memory upload: the control plane refused ${ENTRY.path} (400); it is sent again when the file changes`,
      `memory upload: the control plane refused ${ENTRY.path} (413); it is sent again when the file changes`,
      `memory upload: the control plane refused ${ENTRY.path} (422); it is sent again when the file changes`,
    ]);
  });

  it("rejects at any other answer, and logs a failure only when it changes", async () => {
    const { fetch } = plane([503, 503, new Error("ECONNREFUSED"), 200, 503]);
    const { send, lines } = upload(fetch);
    await expect(send(ENTRY)).rejects.toThrow("503");
    await expect(send(ENTRY)).rejects.toThrow("503");
    await expect(send(ENTRY)).rejects.toThrow("unreachable (ECONNREFUSED)");
    await expect(send(ENTRY)).resolves.toBeUndefined();
    // A success clears the last failure, so the same failure logs again.
    await expect(send(ENTRY)).rejects.toThrow("503");
    expect(lines).toEqual([
      "memory upload: the control plane answered 503; local memories wait for the next scan",
      "memory upload: the control plane is unreachable (ECONNREFUSED); local memories wait for the next scan",
      "memory upload: the control plane answered 503; local memories wait for the next scan",
    ]);
  });

  it("abandons an upload that takes longer than the timeout", async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    const lines: string[] = [];
    const send = createMemoryUpload({
      host: () => ({
        api_url: "https://api.oxagen.test",
        api_key: "k",
        host_enrollment_id: HOST_ENROLLMENT_ID,
      }),
      fetch,
      log: (line) => lines.push(line),
      timeoutMs: 5,
    });
    await expect(send(ENTRY)).rejects.toThrow("unreachable (aborted)");
    expect(lines).toHaveLength(1);
  });
});
