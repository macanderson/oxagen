import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app";

/** Direct app.fetch tests need the response consumption an HTTP server supplies. */
export function createTestResponseTransport() {
  const streams = new Set<Response>();
  return {
    wrap(middleware: MiddlewareHandler<AppEnv>): MiddlewareHandler<AppEnv> {
      return async (c, next) => {
        const result = await middleware(c, next);
        const response = result instanceof Response ? result : c.res;
        if (response.body === null) return response;
        if (response.headers.get("content-type")?.includes("text/event-stream")) {
          streams.add(response);
          return response;
        }
        // Keep the client body readable after the server has sent its bytes.
        return new Response(await response.arrayBuffer(), response);
      };
    },
    async cleanup() {
      const errors: unknown[] = [];
      try {
        for (const response of streams) {
          try {
            if (response.body?.locked)
              throw new Error("Release the response reader before test cleanup.");
            await response.body?.cancel();
          } catch (error) {
            errors.push(error);
          }
        }
      } finally {
        streams.clear();
      }
      if (errors.length > 0) throw new AggregateError(errors, "Response cleanup failed.");
    },
  };
}
