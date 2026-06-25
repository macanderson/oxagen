import type { Argument, Command, Option } from "commander";

export interface ArgSpec {
  name: string;
  required: boolean;
  variadic: boolean;
  description: string;
}

export interface OptSpec {
  flags: string;
  long: string;
  short?: string;
  description: string;
  required: boolean;
  isBoolean: boolean;
  takesValue: boolean;
  defaultValue?: unknown;
  secret: boolean;
  choices?: string[];
}

export interface CommandNode {
  name: string;
  description: string;
  path: string[];
  args: ArgSpec[];
  options: OptSpec[];
  children: CommandNode[];
  runnable: boolean;
}

// Flags whose values must never be shown in plaintext in the form.
const SECRET_RE = /(password|secret|token|api[-_]?key|auth[-_]?config)/i;

export function buildCommandTree(program: Command): CommandNode {
  return toNode(program, []);
}

function toNode(cmd: Command, path: string[]): CommandNode {
  const children = cmd.commands
    .filter((c) => c.name() !== "help")
    .map((c) => toNode(c, [...path, c.name()]));
  return {
    name: cmd.name(),
    description: cmd.description() ?? "",
    path,
    args: cmd.registeredArguments.map(toArgSpec),
    options: cmd.options.map(toOptSpec),
    children,
    runnable: children.length === 0,
  };
}

function toArgSpec(a: Argument): ArgSpec {
  return {
    name: a.name(),
    required: a.required,
    variadic: a.variadic,
    description: a.description ?? "",
  };
}

function toOptSpec(o: Option): OptSpec {
  const long = o.long ?? "";
  return {
    flags: o.flags,
    long,
    short: o.short ?? undefined,
    description: o.description ?? "",
    required: o.mandatory,
    isBoolean: o.isBoolean(),
    takesValue: !o.isBoolean(),
    defaultValue: o.defaultValue,
    secret: SECRET_RE.test(long),
    choices: o.argChoices,
  };
}
