// screen.ts: the sensitive-data screen work intake runs before it stores or
// quotes outside text (agent-work-phase-1.html, Delivery and review).
//
// Every string in a value passes through the recorder's credential detectors
// (@oxagen/recorder/redaction), which replace a token, key, or private key with
// a marker such as `[redacted:github_token]`, and loses its control
// characters other than tab, newline, and carriage return. The detectors match
// credential shapes with fixed prefixes. They find what they know and miss
// what they do not, so a screened value can still hold sensitive text, and
// nothing here promises otherwise.
import { redactText } from "@oxagen/recorder/redaction";

const MARKER = "[redacted:";

/** Control characters other than tab, newline, and carriage return. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

function markers(text: string): number {
  return text.split(MARKER).length - 1;
}

/** One string, screened, and how many credentials the screen removed. */
export function screenText(text: string): { text: string; redactions: number } {
  const redacted = redactText(text.replace(CONTROL, ""));
  return { text: redacted, redactions: Math.max(0, markers(redacted) - markers(text)) };
}

/** Every string in a JSON-shaped value, screened. Other values pass unchanged. */
export function screenValue<T>(value: T): { value: T; redactions: number } {
  let redactions = 0;
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      const out = screenText(node);
      redactions += out.redactions;
      return out.text;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([key, entry]) => [key, walk(entry)]));
    }
    return node;
  };
  return { value: walk(value) as T, redactions };
}
