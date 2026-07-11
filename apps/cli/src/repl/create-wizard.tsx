/**
 * create-wizard.tsx — the scaffolding wizard behind `/create-command`,
 * `/create-agent`, `/create-skill`, and `/create-prompt` (one component,
 * selected by `kind`).
 *
 * A two-step takeover flow:
 *   1. name — a single-line input for the new artifact's name, validated as
 *      non-empty kebab-case (see {@link isValidName}). Enter advances; Esc
 *      cancels the whole wizard.
 *   2. confirm — echoes what will be created; Enter runs the injected `scaffold`
 *      and moves to the result; Esc returns to step 1 to rename.
 * The result then reports the created path (or, when the artifact already
 * existed, says so) and offers to open it in the editor via `openInEditor`.
 *
 * Everything that touches the filesystem is injected — `scaffold` creates the
 * file(s) and reports the path + whether it was newly created; `openInEditor`
 * launches the editor — so the wizard is a pure keyboard-driven state machine
 * under test.
 */
import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import { theme } from "../tui/theme.js";

/** The artifacts the wizard can scaffold. */
export type CreateKind = "command" | "agent" | "skill" | "prompt";

/** The outcome of a scaffold call: where it lives, and whether it was new. */
export interface ScaffoldResult {
  path: string;
  created: boolean;
}

/**
 * A non-empty kebab-case name: lowercase alphanumerics in hyphen-separated
 * segments (`code-review`, `deploy`, `v2`), never leading/trailing/double
 * hyphens. The scaffold path and command name derive from it.
 */
export function isValidName(name: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

/** Human, article-friendly label for the kind, e.g. "slash command". */
function kindLabel(kind: CreateKind): string {
  switch (kind) {
    case "command":
      return "slash command";
    case "agent":
      return "agent";
    case "skill":
      return "skill";
    case "prompt":
      return "saved prompt";
  }
}

type Step = "name" | "confirm" | "result";

export interface CreateWizardProps {
  /** False while another surface owns the keyboard; the wizard ignores keys. */
  active?: boolean;
  kind: CreateKind;
  onClose: () => void;
  /** Fired with the path once a NEW artifact is scaffolded. */
  onCreated: (path: string) => void;
  /** Create the artifact on disk and report its path + whether it was new. */
  scaffold: (kind: CreateKind, name: string) => ScaffoldResult;
  /** Open the finished artifact in the user's editor (bound to `o`). */
  openInEditor?: (path: string) => void;
  width?: number;
}

export function CreateWizard({
  active = true,
  kind,
  onClose,
  onCreated,
  scaffold,
  openInEditor,
  width = 84,
}: CreateWizardProps): React.ReactElement {
  const [step, setStep] = useState<Step>("name");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScaffoldResult | null>(null);

  useInput(
    (input, key) => {
      if (step === "name") {
        if (key.escape) {
          onClose();
          return;
        }
        if (key.return) {
          const trimmed = name.trim();
          if (isValidName(trimmed)) {
            setName(trimmed);
            setError(null);
            setStep("confirm");
          } else {
            setError(
              "use kebab-case: lowercase letters, digits and hyphens (e.g. code-review)",
            );
          }
          return;
        }
        if (key.backspace || key.delete) {
          setError(null);
          setName((n) => n.slice(0, -1));
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          setError(null);
          setName((n) => n + input);
        }
        return;
      }

      if (step === "confirm") {
        if (key.escape) {
          setStep("name");
          return;
        }
        if (key.return) {
          const res = scaffold(kind, name);
          setResult(res);
          if (res.created) onCreated(res.path);
          setStep("result");
        }
        return;
      }

      // step === "result"
      if (input === "o" && result && openInEditor) {
        openInEditor(result.path);
        return;
      }
      if (key.escape) {
        onClose();
      }
    },
    { isActive: active },
  );

  const innerWidth = Math.max(width - 4, 20);
  const label = kindLabel(kind);

  if (step === "confirm") {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.violet}
        paddingX={1}
        width={width}
      >
        <Text color={theme.violet} bold>
          {`New ${label}`}
        </Text>
        <Box marginTop={1} gap={1}>
          <Text>Create {label}</Text>
          <Text color={theme.cyan} bold>
            {name}
          </Text>
          <Text>?</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>enter to create · esc to rename</Text>
        </Box>
      </Box>
    );
  }

  if (step === "result" && result) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={result.created ? theme.green : theme.amber}
        paddingX={1}
        width={width}
      >
        <Box gap={1} width={innerWidth}>
          {result.created ? (
            <>
              <Text color={theme.green} bold>
                ✓ created
              </Text>
              <Text wrap="truncate-end">{result.path}</Text>
            </>
          ) : (
            <>
              <Text color={theme.amber} bold wrap="truncate-end">
                {result.path}
              </Text>
              <Text dimColor>already exists</Text>
            </>
          )}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            {openInEditor
              ? `press o to open ${result.created ? "in your editor" : "it"} · esc to close`
              : "esc to close"}
          </Text>
        </Box>
      </Box>
    );
  }

  // step === "name"
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.violet}
      paddingX={1}
      width={width}
    >
      <Text color={theme.violet} bold>
        {`New ${label}`}
      </Text>
      <Box marginTop={1} width={innerWidth}>
        <Text dimColor>name </Text>
        <Text color={theme.cyan}>{"❯ "}</Text>
        <Text>
          {name}
          <Text color={theme.cyan}>█</Text>
        </Text>
      </Box>
      {error ? (
        <Box marginTop={1}>
          <Text color={theme.red} wrap="truncate-end">
            {error}
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>enter to continue · esc to cancel</Text>
      </Box>
    </Box>
  );
}
