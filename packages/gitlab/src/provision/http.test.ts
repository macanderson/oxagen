import { afterEach, describe, expect, it, vi } from "vitest";
import { GitLabApiError } from "../client";
import {
  createGitlabRest,
  GitLabRateLimitedError,
  RATE_LIMIT_RETRY_MS,
  requireData,
  seg,
  SteeringGitlabReauthorizeError,
} from "./http";
import type { HttpFetch } from "./http";

const TOKEN = "glpat-steering-SECRET";

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A fetch that answers every request with `status` and `text`, and records what it got. */
function answering(status: number, text: string): { fetch: HttpFetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetch: HttpFetch = (url, init) => {
    sent.push({ url, ...init });
    return Promise.resolve({ status, text: () => Promise.resolve(text) });
  };
  return { fetch, sent };
}

function restAnswering(status: number, body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const stub = answering(status, text);
  return { rest: createGitlabRest({ token: TOKEN, baseUrl: "https://gitlab.test/", fetch: stub.fetch }), sent: stub.sent };
}

async function thrown(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the request to throw");
}

describe("createGitlabRest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the parsed body of a 2xx answer", async () => {
    const { rest, sent } = restAnswering(200, { id: 12 });
    const res = await rest.request<{ id: number }>("GET", "/projects/12");
    expect(res).toEqual({ status: 200, data: { id: 12 }, message: null });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://gitlab.test/api/v4/projects/12");
    expect(sent[0]?.headers).toEqual({ "PRIVATE-TOKEN": TOKEN, Accept: "application/json" });
    expect(sent[0]?.body).toBeUndefined();
  });

  it("sends a JSON body with its content type", async () => {
    const { rest, sent } = restAnswering(201, { id: 3 });
    await rest.request("POST", "/projects", { name: "oxagen-support" });
    expect(sent[0]?.method).toBe("POST");
    expect(sent[0]?.headers["Content-Type"]).toBe("application/json");
    expect(sent[0]?.body).toBe('{"name":"oxagen-support"}');
  });

  it("returns null data for an empty body and for a body that is not JSON", async () => {
    const empty = restAnswering(204, "");
    expect((await empty.rest.request("DELETE", "/projects/1/protected_branches/main")).data).toBeNull();
    const html = restAnswering(200, "<html>");
    expect((await html.rest.request("GET", "/user")).data).toBeNull();
  });

  it("returns an accepted status with null data and GitLab's message", async () => {
    const { rest } = restAnswering(404, { message: "404 Project Not Found" });
    const res = await rest.request("GET", "/projects/acme%2Fmissing", undefined, [404]);
    expect(res).toEqual({ status: 404, data: null, message: "404 Project Not Found" });
  });

  it("throws GitLabApiError for a status the caller did not accept", async () => {
    const { rest } = restAnswering(404, { message: "404 Project Not Found" });
    const error = await thrown(rest.request("GET", "/projects/9"));
    expect(error).toBeInstanceOf(GitLabApiError);
    expect(error).toMatchObject({ status: 404, message: "GitLab API error 404: 404 Project Not Found" });
  });

  it.each([
    [{ message: { name: ["has already been taken"], path: ["has already been taken"] } }, "name has already been taken; path has already been taken"],
    [{ message: { base: ["Could not change HEAD"] } }, "Could not change HEAD"],
    [{ message: ["first", "second"] }, "first; second"],
    [{ message: "   ", error: "ref is missing" }, "ref is missing"],
    [{ error: "invalid_token", error_description: "Token was revoked" }, "invalid_token: Token was revoked"],
    [{ message: { count: 5 } }, "status 400"],
    [{ message: [] }, "status 400"],
    [{}, "status 400"],
    ["not json", "status 400"],
  ])("flattens the message of %j", async (body, expected) => {
    const { rest } = restAnswering(400, body);
    const res = await rest.request("POST", "/projects", {}, [400]);
    expect(res.message).toBe(expected);
  });

  it("scrubs the token from messages and cuts long ones", async () => {
    const leaky = restAnswering(400, { message: `token ${TOKEN} is not valid` });
    expect((await leaky.rest.request("GET", "/user", undefined, [400])).message).toBe("token [redacted] is not valid");
    const long = restAnswering(400, { message: "x".repeat(600) });
    const message = (await long.rest.request("GET", "/user", undefined, [400])).message;
    expect(message).toBe(`${"x".repeat(500)}...`);
  });

  it("throws SteeringGitlabReauthorizeError on 401, even when 401 is accepted", async () => {
    const { rest } = restAnswering(401, { message: "401 Unauthorized" });
    const error = await thrown(rest.request("GET", "/user", undefined, [401]));
    expect(error).toBeInstanceOf(SteeringGitlabReauthorizeError);
    expect(error).toMatchObject({
      code: "steering_reauthorize",
      status: 401,
      name: "SteeringGitlabReauthorizeError",
      message: "GitLab refused the steering token: 401 Unauthorized",
    });
  });

  it("throws GitLabRateLimitedError on 429, even when 429 is accepted", async () => {
    const { rest } = restAnswering(429, { message: "Retry later" });
    const error = await thrown(rest.request("GET", "/user", undefined, [429]));
    expect(error).toBeInstanceOf(GitLabRateLimitedError);
    expect(error).toBeInstanceOf(GitLabApiError);
    expect(error).toMatchObject({
      code: "gitlab_rate_limited",
      status: 429,
      retryAfterMs: RATE_LIMIT_RETRY_MS,
      name: "GitLabRateLimitedError",
    });
    expect(RATE_LIMIT_RETRY_MS).toBe(60_000);
  });

  it("calls the global fetch at gitlab.com when no fetch is given", async () => {
    const stub = answering(200, '{"id":99,"username":"bot"}');
    vi.stubGlobal("fetch", stub.fetch);
    const rest = createGitlabRest({ token: TOKEN });
    const res = await rest.request<{ id: number }>("GET", "/user");
    expect(res.data).toEqual({ id: 99, username: "bot" });
    expect(stub.sent[0]?.url).toBe("https://gitlab.com/api/v4/user");
  });
});

describe("requireData", () => {
  it("returns the body and throws when there is none", () => {
    expect(requireData({ status: 200, data: { id: 1 }, message: null }, "user")).toEqual({ id: 1 });
    expect(() => requireData({ status: 204, data: null, message: null }, "user")).toThrow(
      "GitLab API error 204: GitLab returned no user",
    );
  });
});

describe("seg", () => {
  it("encodes one path segment", () => {
    expect(seg("acme/oxagen-support")).toBe("acme%2Foxagen-support");
    expect(seg(".oxagen/rules/a b.md")).toBe(".oxagen%2Frules%2Fa%20b.md");
    expect(seg(12)).toBe("12");
  });
});
