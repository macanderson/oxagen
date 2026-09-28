// compare.ts: the first place two JSON values differ (mcp-studio-spec, Try it
// and tests).
//
// Replay compares a recorded request with the one the executor built, and a
// recorded result with the replayed one. Each side is copied as plain JSON
// first, so a key set to undefined counts as absent, as it would in
// calls.jsonl. Object key order does not matter. Array order does.
import { plainJson } from "../contract/json";
import { isList, isRecord } from "../execute/util";

/** Where two values differ, and what each side holds there. */
export interface ValueDifference {
  /** A path such as data[0].amount. Empty when the values differ at the top. */
  path: string;
  /** The recording's value, or undefined when the recording has nothing there. */
  expected: unknown;
  /** The replay's value, or undefined when the replay has nothing there. */
  actual: unknown;
}

const PLAIN_KEY = /^[A-Za-z_$][\w$-]*$/;

function keyPath(path: string, key: string): string {
  if (!PLAIN_KEY.test(key)) return `${path}[${JSON.stringify(key)}]`;
  return path === "" ? key : `${path}.${key}`;
}

function differenceAt(path: string, expected: unknown, actual: unknown): ValueDifference | undefined {
  if (isList(expected) && isList(actual)) {
    const shared = Math.min(expected.length, actual.length);
    for (let index = 0; index < shared; index++) {
      const found = differenceAt(`${path}[${index}]`, expected[index], actual[index]);
      if (found !== undefined) return found;
    }
    if (expected.length === actual.length) return undefined;
    return { path: `${path}[${shared}]`, expected: expected[shared], actual: actual[shared] };
  }
  if (isRecord(expected) && isRecord(actual)) {
    for (const key of Object.keys(expected)) {
      const found = differenceAt(keyPath(path, key), expected[key], Object.hasOwn(actual, key) ? actual[key] : undefined);
      if (found !== undefined) return found;
    }
    for (const key of Object.keys(actual)) {
      if (!Object.hasOwn(expected, key)) return { path: keyPath(path, key), expected: undefined, actual: actual[key] };
    }
    return undefined;
  }
  return expected === actual ? undefined : { path, expected, actual };
}

/** The first place the replay differs from the recording, or undefined when they match. */
export function firstDifference(expected: unknown, actual: unknown): ValueDifference | undefined {
  return differenceAt("", plainJson(expected), plainJson(actual));
}

const SHOWN_CHARACTERS = 120;

/** A value as a message shows it: JSON cut to 120 characters, or "nothing" when absent. */
export function describeValue(value: unknown): string {
  if (value === undefined) return "nothing";
  const text = JSON.stringify(value);
  return text.length <= SHOWN_CHARACTERS ? text : `${text.slice(0, SHOWN_CHARACTERS)}...`;
}

/** "at data[0].amount", or "at the top level" for an empty path. */
export function describePath(path: string): string {
  return path === "" ? "at the top level" : `at ${path}`;
}
