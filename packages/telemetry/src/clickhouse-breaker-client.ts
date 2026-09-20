import type { ClickHouseClient } from "@clickhouse/client";
import type { Readable } from "node:stream";
import {
  getBreaker,
  CircuitBreaker,
  type CircuitLease,
  type CircuitBreakerOptions,
} from "./circuit-breaker";
import { breakerEnvConfig } from "./breaker-config";

export function clickhouseClientBreaker(
  key: string,
  registered = true,
): CircuitBreaker {
  const options: CircuitBreakerOptions = {
    ...breakerEnvConfig(),
    onTransition: (transition) => {
      process.stderr.write(
        `[circuit-breaker] ${transition.key} ${transition.from}->${transition.to} (failures=${transition.failureCount})\n`,
      );
    },
  };
  return registered
    ? getBreaker(key, options)
    : new CircuitBreaker(key, options);
}

function observeStream(stream: Readable, lease: CircuitLease): Readable {
  stream.once("end", () => lease.succeed());
  stream.once("error", (error) => lease.fail(error));
  stream.once("close", () => lease.cancel());
  return stream;
}

/** Guard response consumption as well as headers, without buffering streaming reads. */
function guardResult(result: object, lease: CircuitLease): object {
  return new Proxy(result, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      const call = (...args: unknown[]): unknown =>
        Reflect.apply(value, target, args);
      if (key === "json" || key === "text")
        return async (...args: unknown[]) => {
          try {
            const output = await call(...args);
            lease.succeed();
            return output;
          } catch (error) {
            lease.fail(error);
            throw error;
          }
        };
      if (key === "stream")
        return (...args: unknown[]) => {
          try {
            return observeStream(call(...args) as Readable, lease);
          } catch (error) {
            lease.fail(error);
            throw error;
          }
        };
      if (key === "close" || key === Symbol.dispose)
        return (...args: unknown[]) => {
          try {
            return call(...args);
          } finally {
            lease.cancel();
          }
        };
      return call;
    },
  });
}

/** Close stays unguarded so cleanup works while the dependency is unavailable. */
export function guardClickhouseClient(
  client: ClickHouseClient,
  breaker: CircuitBreaker,
): ClickHouseClient {
  const remote = new Set<PropertyKey>([
    "query",
    "insert",
    "command",
    "exec",
    "ping",
  ]);
  return new Proxy(client, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (!remote.has(key))
        return (...args: unknown[]): unknown =>
          Reflect.apply(value, target, args);
      return async (...args: unknown[]) => {
        const lease = breaker.begin();
        try {
          const result: unknown = await Reflect.apply(value, target, args);
          if (key === "query" && result !== null && typeof result === "object")
            return guardResult(result, lease);
          if (
            key === "exec" &&
            result !== null &&
            typeof result === "object" &&
            "stream" in result
          ) {
            observeStream(result.stream as Readable, lease);
            return result;
          }
          if (
            key === "ping" &&
            result !== null &&
            typeof result === "object" &&
            "success" in result &&
            !result.success
          ) {
            lease.fail("ClickHouse health check failed");
            return result;
          }
          lease.succeed();
          return result;
        } catch (error) {
          lease.fail(error);
          throw error;
        }
      };
    },
  });
}
