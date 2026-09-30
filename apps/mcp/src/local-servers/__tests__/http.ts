// http.ts: a fake node response, and one request through the local-server
// route, for the route and witness tests (#4773). Nothing in production
// imports this file.
import { EventEmitter } from "node:events";
import type { LocalServersMiddleware, LocalServersRequest, LocalServersResponse } from "../route";

/** What the route sent: its status, its headers, and its body as text. */
export interface Answer {
  status: number;
  headers: Record<string, unknown>;
  body: string;
}

/** A response that records what the route writes, and closes the way a node response does. */
export class FakeResponse extends EventEmitter implements LocalServersResponse {
  statusCode = 200;
  writableEnded = false;
  destroyed = false;
  readonly headers: Record<string, unknown> = {};
  readonly answered: Promise<Answer>;
  private settle: (answer: Answer) => void = () => undefined;

  constructor() {
    super();
    this.answered = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  writeHead = (status: number, ...rest: unknown[]): FakeResponse => {
    this.statusCode = status;
    const headers = rest.find((value) => typeof value === "object" && value !== null);
    if (headers !== undefined) Object.assign(this.headers, headers);
    return this;
  };

  write = (): boolean => true;

  end = (...rest: unknown[]): FakeResponse => {
    const chunk = rest[0];
    this.writableEnded = true;
    this.settle({ status: this.statusCode, headers: { ...this.headers }, body: typeof chunk === "string" ? chunk : "" });
    this.emit("close");
    return this;
  };

  setHeader = (name: string, value: string | number | readonly string[]): FakeResponse => {
    this.headers[name.toLowerCase()] = value;
    return this;
  };

  getHeader = (name: string): unknown => this.headers[name.toLowerCase()];

  removeHeader = (name: string): void => {
    Reflect.deleteProperty(this.headers, name.toLowerCase());
  };

  /** The client hangs up before the route answers. */
  hangUp(): void {
    this.destroyed = true;
    this.emit("close");
  }
}

/** Sends one request through the route. "passed" means the route called next(). */
export function serve(
  route: LocalServersMiddleware,
  req: LocalServersRequest,
  res: FakeResponse = new FakeResponse(),
): Promise<Answer | "passed"> {
  return new Promise((resolve, reject) => {
    void res.answered.then(resolve);
    route(req, res, (error?: unknown) => {
      if (error === undefined) resolve("passed");
      else reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}
