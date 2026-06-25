import { Box, Text } from "ink";
import net from "node:net";
import { useEffect, useState } from "react";
import { theme } from "../tui/theme.js";

// Services the dev stack exposes. Port values must stay in sync with the
// turbo dev task config (apps/*/project.json + apps/*/next.config.ts).
const SERVICES: ReadonlyArray<{ name: string; port: number }> = [
  { name: "api", port: 4000 },
  { name: "mcp", port: 4100 },
  { name: "runner", port: 4200 },
  { name: "app", port: 3000 },
];

type PortState = "checking" | "up" | "down";

interface ServiceStatus {
  name: string;
  port: number;
  state: PortState;
}

/**
 * Probe a TCP port on localhost. Resolves true when the port accepts a
 * connection within the timeout; false otherwise.
 */
function checkPort(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const settle = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
    socket.connect(port, "127.0.0.1");
  });
}

export function DevStatus() {
  const [statuses, setStatuses] = useState<ServiceStatus[]>(
    SERVICES.map((s) => ({ ...s, state: "checking" as PortState })),
  );

  useEffect(() => {
    let cancelled = false;

    // Probe all ports in parallel; update each one as the result arrives.
    // checkPort never rejects, so no unhandled-rejection risk.
    for (const svc of SERVICES) {
      void checkPort(svc.port).then((isUp) => {
        if (cancelled) return;
        setStatuses((prev) =>
          prev.map((row) =>
            row.port === svc.port ? { ...row, state: isUp ? "up" : "down" } : row,
          ),
        );
      });
    }

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        {/* Brand banner: cyan ring glyph + violet "Oxagen" wordmark (Oxagen jewel palette). */}
        <Text color={theme.cyan}>{theme.ring} </Text>
        <Text color={theme.violet} bold>
          Oxagen
        </Text>
        <Text dimColor> dev stack</Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        {statuses.map((row) => (
          <Text key={row.name}>
            <Text color="cyan">{row.name.padEnd(10)}</Text>
            <Text color="gray">:{row.port}  </Text>
            <ServiceStateLabel state={row.state} />
          </Text>
        ))}
      </Box>
      <Text dimColor>Run `pnpm dev` from the repo root to bring the stack online.</Text>
    </Box>
  );
}

function ServiceStateLabel({ state }: { state: PortState }) {
  if (state === "checking") return <Text color="gray">checking…</Text>;
  if (state === "up") return <Text color="green">up</Text>;
  return <Text color="red">down</Text>;
}
