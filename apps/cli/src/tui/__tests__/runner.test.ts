import { describe, it, expect, vi } from "vitest";
import type { CommandNode } from "../command-tree.js";
import { assembleArgv } from "../runner.js";

const node: CommandNode = {
  name: "login",
  description: "Authenticate",
  path: ["auth", "login"],
  args: [{ name: "name", required: true, variadic: false, description: "" }],
  options: [
    { flags: "--email <e>", long: "--email", description: "", required: true, isBoolean: false, takesValue: true, secret: false },
    { flags: "--remember", long: "--remember", description: "", required: false, isBoolean: true, takesValue: false, secret: false },
    { flags: "--tags <t...>", long: "--tags", description: "", required: false, isBoolean: false, takesValue: true, secret: false },
    { flags: "--note <n>", long: "--note", description: "", required: false, isBoolean: false, takesValue: true, secret: false },
  ],
  children: [],
  runnable: true,
};

describe("assembleArgv", () => {
  it("orders positionals, includes set options, and drops empty/false ones", () => {
    const argv = assembleArgv(node, {
      "arg:name": "acme",
      "opt:--email": "you@example.com",
      "opt:--remember": true,
    });
    expect(argv).toEqual(["acme", "--email=you@example.com", "--remember"]);
  });

  it("omits boolean flags that are false and value options left blank", () => {
    const argv = assembleArgv(node, { "arg:name": "acme", "opt:--remember": false, "opt:--email": "" });
    expect(argv).toEqual(["acme"]);
  });

  it("emits option values beginning with dash as single token to prevent misparsing", () => {
    const argv = assembleArgv(node, {
      "arg:name": "acme",
      "opt:--note": "-5",
    });
    expect(argv).toEqual(["acme", "--note=-5"]);
  });
});
