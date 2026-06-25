import { PasswordInput, TextInput } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import type { CommandNode } from "./command-tree.js";
import type { FormValues } from "./runner.js";
import { theme } from "./theme.js";

interface Field {
  key: string; // FormValues key: arg:<name> | opt:<long>
  label: string;
  description: string;
  required: boolean;
  kind: "text" | "secret" | "bool";
}

function fieldsOf(node: CommandNode): Field[] {
  const argFields: Field[] = node.args.map((a) => ({
    key: `arg:${a.name}`,
    label: `<${a.name}>`,
    description: a.description,
    required: a.required,
    kind: "text",
  }));
  const optFields: Field[] = node.options.map((o) => ({
    key: `opt:${o.long}`,
    label: o.long,
    description: o.description,
    required: o.required,
    kind: o.isBoolean ? "bool" : o.secret ? "secret" : "text",
  }));
  return [...argFields, ...optFields];
}

export function CommandForm(props: {
  node: CommandNode;
  onSubmit: (values: FormValues) => void;
  onCancel: () => void;
}): React.ReactElement {
  const fields = fieldsOf(props.node);
  const [values, setValues] = useState<FormValues>(() => {
    const initial: FormValues = {};
    for (const f of fields) if (f.kind === "bool") initial[f.key] = false;
    return initial;
  });
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const missing = (): Field | undefined =>
    fields.find((f) => f.required && f.kind !== "bool" && !String(values[f.key] ?? "").trim());

  const trySubmit = () => {
    const m = missing();
    if (m) {
      setError(`${m.label} is required`);
      return;
    }
    props.onSubmit(values);
  };

  // @inkjs/ui TextInput and PasswordInput consume their own character input and
  // report changes via `onChange` only — they do NOT fire an `onSubmit` event
  // that reaches this `useInput` handler. All navigation (Enter, Esc, arrows)
  // is handled exclusively here. Do NOT wire a conflicting `onSubmit` prop on
  // the @inkjs/ui inputs; it would create a second, uncoordinated submit path.
  useInput((input, key) => {
    if (key.escape) return props.onCancel();
    if (key.downArrow || key.tab) setActive((i) => Math.min(i + 1, fields.length - 1));
    else if (key.upArrow) setActive((i) => Math.max(i - 1, 0));
    else if (key.return) {
      // Enter on the last field always submits (regardless of field kind).
      // Enter on any other field advances focus to the next field.
      if (active === fields.length - 1) trySubmit();
      else setActive((i) => Math.min(i + 1, fields.length - 1));
    } else if (input === " ") {
      // Space is the sole toggle key for boolean fields.
      const f = fields[active];
      if (f?.kind === "bool") setValues((v) => ({ ...v, [f.key]: !v[f.key] }));
    }
  });

  const setVal = (key: string, val: string) => setValues((v) => ({ ...v, [key]: val }));

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        <Text color={theme.violet} bold>
          {props.node.path.join(" › ")}
        </Text>
      </Text>
      <Text dimColor>{props.node.description}</Text>
      <Box flexDirection="column" marginTop={1}>
        {fields.map((f, i) => {
          const focused = i === active;
          return (
            <Box key={f.key} flexDirection="column" marginBottom={1}>
              <Text>
                <Text color={focused ? theme.cyan : undefined}>{focused ? `${theme.pointer} ` : "  "}</Text>
                <Text bold={focused}>{f.label}</Text>
                {f.required ? <Text color={theme.violet}> (required)</Text> : null}
                {f.description ? <Text dimColor>{`  ${f.description}`}</Text> : null}
              </Text>
              <Box marginLeft={2}>
                {f.kind === "bool" ? (
                  <Text color={values[f.key] ? theme.cyan : undefined}>
                    {values[f.key] ? "[x] on" : "[ ] off"} {focused ? "(space toggles)" : ""}
                  </Text>
                ) : f.kind === "secret" ? (
                  <PasswordInput isDisabled={!focused} placeholder="•••" onChange={(val) => setVal(f.key, val)} />
                ) : (
                  <TextInput isDisabled={!focused} placeholder="…" onChange={(val) => setVal(f.key, val)} />
                )}
              </Box>
            </Box>
          );
        })}
      </Box>
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor>↑/↓ field · space toggles · ↵ next/submit · esc cancel</Text>
    </Box>
  );
}
