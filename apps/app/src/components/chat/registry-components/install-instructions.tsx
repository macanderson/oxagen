/**
 * install-instructions — renders a copy-able installation step block in chat.
 * File owned by the M agent; this stub is the R-agent placeholder.
 * Remove when the M agent delivers the real implementation.
 */
import type React from "react";
export interface InstallInstructionsProps {
  /** The package manager command(s) to display */
  command: string;
  /** Optional package manager label (npm, pnpm, yarn, bun) */
  packageManager?: string;
  /** Optional heading / context label */
  label?: string;
}

export default function InstallInstructions({
  command,
  packageManager,
  label,
}: InstallInstructionsProps): React.ReactElement | null {
  console.log("[stub] install-instructions — would render install block", {
    command,
    packageManager,
    label,
  });
  return null;
}
