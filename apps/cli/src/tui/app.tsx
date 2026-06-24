// apps/cli/src/tui/app.tsx
// Navigation state machine: list → form → result, with breadcrumb stack,
// cursor movement, and live filter. Entry point: launchTui().
import type { Command } from "commander";
import { Box, Text, useApp, useInput, render } from "ink";
import React, { useMemo, useState } from "react";
import { Banner } from "./banner.js";
import { CommandForm } from "./command-form.js";
import { buildCommandTree, type CommandNode } from "./command-tree.js";
import { assembleArgv, runCommand, type FormValues } from "./runner.js";
import { theme } from "./theme.js";

type Screen =
  | { kind: "list"; node: CommandNode }
  | { kind: "form"; node: CommandNode }
  | { kind: "result"; node: CommandNode; code: number };

// Invariant: stack is always non-empty. Enforced by initial value and the pop()
// guard that calls quit() instead of removing the last element.
function topOf(stack: Screen[]): Screen {
  const top = stack[stack.length - 1];
  // This branch is unreachable in practice; the guard exists only to satisfy
  // the type-checker and avoid a non-null assertion.
  if (!top) throw new Error("invariant violated: empty screen stack");
  return top;
}

export function App(props: { program: Command; version: string; onExit?: () => void }): React.ReactElement {
  const root = useMemo(() => buildCommandTree(props.program), [props.program]);
  const { exit } = useApp();
  const [stack, setStack] = useState<Screen[]>([{ kind: "list", node: root }]);
  const [cursor, setCursor] = useState(0);
  const [filter, setFilter] = useState("");
  const screen = topOf(stack);

  const quit = () => {
    props.onExit?.();
    exit();
  };

  const pop = () => {
    if (stack.length === 1) return quit();
    setStack((s) => s.slice(0, -1));
    setCursor(0);
    setFilter("");
  };

  const push = (s: Screen) => {
    setStack((prev) => [...prev, s]);
    setCursor(0);
    setFilter("");
  };

  const visibleChildren = (node: CommandNode): CommandNode[] =>
    node.children.filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()));

  useInput((input, key) => {
    if (screen.kind !== "list") return; // form/result handle their own input
    if (key.escape) return pop();
    // q quits only when no filter text is active (otherwise it builds the filter string)
    if (input === "q" && filter === "") return quit();

    const items = visibleChildren(screen.node);
    if (key.downArrow) {
      setCursor((c) => Math.min(c + 1, Math.max(items.length - 1, 0)));
    } else if (key.upArrow) {
      setCursor((c) => Math.max(c - 1, 0));
    } else if (key.return) {
      const sel = items[cursor];
      if (!sel) return;
      if (sel.runnable) push({ kind: "form", node: sel });
      else push({ kind: "list", node: sel });
    } else if (key.backspace || key.delete) {
      setFilter((f) => f.slice(0, -1));
    } else if (input && !key.ctrl && !key.meta && input >= " ") {
      setFilter((f) => f + input);
    }
  });

  if (screen.kind === "form") {
    const formNode = screen.node;
    return (
      <CommandForm
        node={formNode}
        onCancel={pop}
        onSubmit={async (values: FormValues) => {
          const argv = assembleArgv(formNode, values);
          const { code } = await runCommand(formNode, argv);
          setStack((s) => [...s.slice(0, -1), { kind: "result", node: formNode, code }]);
        }}
      />
    );
  }

  if (screen.kind === "result") {
    return (
      <ResultView
        node={screen.node}
        code={screen.code}
        onBack={() => {
          setStack((s) => s.slice(0, -1));
          setCursor(0);
        }}
        onQuit={quit}
      />
    );
  }

  const items = visibleChildren(screen.node);
  const crumb = ["oxagen", ...screen.node.path].join(" › ");

  return (
    <Box flexDirection="column">
      {stack.length === 1 ? <Banner version={props.version} /> : null}
      <Box paddingX={1}>
        <Text color={theme.violet} bold>
          {crumb}
        </Text>
        {filter ? <Text dimColor>{`   /${filter}`}</Text> : null}
      </Box>
      <Box paddingX={1}>
        <Text dimColor>↑/↓ move · ↵ select · esc back · q quit · type to filter</Text>
      </Box>
      <Box flexDirection="column" paddingX={1} marginTop={1}>
        {items.length === 0 ? (
          <Text dimColor>no matches</Text>
        ) : (
          items.map((c, i) => (
            <Text key={c.name} color={i === cursor ? theme.cyan : undefined}>
              {i === cursor ? `${theme.pointer} ` : "  "}
              <Text bold={i === cursor}>{c.name.padEnd(16)}</Text>
              <Text dimColor>{c.description}</Text>
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
}

function ResultView(props: {
  node: CommandNode;
  code: number;
  onBack: () => void;
  onQuit: () => void;
}): React.ReactElement {
  useInput((input, key) => {
    if (key.escape || key.return) props.onBack();
    else if (input === "q") props.onQuit();
  });
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        <Text color={theme.violet} bold>
          {props.node.path.join(" › ")}
        </Text>{" "}
        <Text color={props.code === 0 ? "green" : "red"}>
          {props.code === 0 ? "✓ completed" : `✗ exit ${props.code}`}
        </Text>
      </Text>
      <Text dimColor>↵/esc back to menu · q quit</Text>
    </Box>
  );
}

export function launchTui(program: Command, version: string): Promise<void> {
  return new Promise((resolve) => {
    const { waitUntilExit } = render(<App program={program} version={version} onExit={() => {}} />);
    void waitUntilExit().then(() => resolve());
  });
}
