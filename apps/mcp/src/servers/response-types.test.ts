import type { ServerResponse } from "node:http";
import type { RequestHandler, Response } from "express";
import { expectTypeOf, it } from "vitest";
import type { LocalServersMiddleware, LocalServersResponse } from "../local-servers/route";
import type { ServedMiddleware, ServedResponse } from "./middleware";

it("accepts native Node and Express response overloads", () => {
  expectTypeOf<ServerResponse>().toMatchTypeOf<ServedResponse>();
  expectTypeOf<ServerResponse>().toMatchTypeOf<LocalServersResponse>();
  expectTypeOf<Response>().toMatchTypeOf<ServedResponse>();
  expectTypeOf<ServedMiddleware>().toMatchTypeOf<RequestHandler>();
  expectTypeOf<LocalServersMiddleware>().toMatchTypeOf<RequestHandler>();
});
