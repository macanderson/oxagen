// @vitest-environment jsdom
/**
 * status-icon.test.tsx
 *
 * Render tests for StatusIcon:
 *   - Each status renders the correct aria-label
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { StatusIcon } from "./status-icon";

afterEach(cleanup);

// Stub lucide icons to simple spans with the label text
vi.mock("lucide-react", () => ({
  Check: ({ "aria-label": label }: { "aria-label"?: string }) => <span aria-label={label}>✓</span>,
  Loader2: ({ "aria-label": label }: { "aria-label"?: string }) => <span aria-label={label}>○</span>,
  X: ({ "aria-label": label }: { "aria-label"?: string }) => <span aria-label={label}>✗</span>,
  // Other icons used by other components - stub safely
  ChevronDown: () => <span />,
  ChevronRight: () => <span />,
  Brain: () => <span />,
  ShieldAlert: () => <span />,
  Users: () => <span />,
  ListChecks: () => <span />,
  GripVertical: () => <span />,
  MoveRight: () => <span />,
  Plus: () => <span />,
  Trash2: () => <span />,
  AlertTriangle: () => <span />,
  Film: () => <span />,
  Send: () => <span />,
  ImageIcon: () => <span />,
  Video: () => <span />,
  ChevronUp: () => <span />,
  Paperclip: () => <span />,
  LoaderCircle: () => <span />,
  FileText: () => <span />,
  FileArchive: () => <span />,
  File: () => <span />,
  Image: () => <span />,
  ExternalLink: () => <span />,
  CheckCircle2: () => <span />,
  XCircle: () => <span />,
  CircleDot: () => <span />,
  Download: () => <span />,
  BarChart3: () => <span />,
  Clock: () => <span />,
  Copy: () => <span />,
  Terminal: () => <span />,
  UserPlus: () => <span />,
  Building2: () => <span />,
  FolderPlus: () => <span />,
  Cpu: () => <span />,
  Coins: () => <span />,
  CreditCard: () => <span />,
  ArrowUpRight: () => <span />,
  VideoOff: () => <span />,
  ImageOff: () => <span />,
  Wand2: () => <span />,
  LayoutTemplate: () => <span />,
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: string[]) => args.filter(Boolean).join(" "),
}));

describe("StatusIcon", () => {
  it("renders 'Composing' for pending status", () => {
    render(<StatusIcon status="pending" />);
    expect(screen.getByLabelText("Composing")).toBeInTheDocument();
  });

  it("renders 'Running' for running status", () => {
    render(<StatusIcon status="running" />);
    expect(screen.getByLabelText("Running")).toBeInTheDocument();
  });

  it("renders 'Completed' for completed status", () => {
    render(<StatusIcon status="completed" />);
    expect(screen.getByLabelText("Completed")).toBeInTheDocument();
  });

  it("renders 'Failed' for failed status", () => {
    render(<StatusIcon status="failed" />);
    expect(screen.getByLabelText("Failed")).toBeInTheDocument();
  });
});
