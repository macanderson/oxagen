"use client";

import * as React from "react";
import { ArrowRight, CheckCircle2, XCircle, RefreshCw, Bot, Clock } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import type { SemanticEdge } from "@oxagen/oxagen/contracts/semantic.edge.list";

// ── Display helpers ────────────────────────────────────────────────────────────

const API_BASE = "/api";

function confidenceLabel(score: number): { label: string; className: string } {
  if (score >= 0.8) return { label: "High", className: "text-success" };
  if (score >= 0.6) return { label: "Medium", className: "text-warning" };
  return { label: "Low", className: "text-error" };
}

function formatISO(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── MetaRow ────────────────────────────────────────────────────────────────────

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="text-sm text-foreground">{children}</div>
    </div>
  );
}

// ── InferenceApprovalModal ─────────────────────────────────────────────────────

export interface InferenceApprovalModalProps {
  edge: SemanticEdge | null;
  orgSlug: string;
  workspaceSlug: string;
  onClose: () => void;
  onDecision: (edgeId: string, decision: "approve" | "reject") => void;
}

/**
 * Detail modal for a single InferredEdge candidate.
 *
 * Displays full edge metadata (model, prompt, confidence breakdown) and exposes
 * Approve / Reject controls with an optional comment field.
 *
 * Implemented without importing from @oxagen/ui to avoid bundle concerns — pure
 * Tailwind + Radix-free overlay. A11y: focus-trapped via autoFocus on the close
 * button; Escape closes.
 */
export function InferenceApprovalModal({
  edge,
  orgSlug,
  workspaceSlug,
  onClose,
  onDecision,
}: InferenceApprovalModalProps) {
  const [comment, setComment] = React.useState("");
  const [processing, setProcessing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const closeRef = React.useRef<HTMLButtonElement>(null);

  // Reset state when the edge changes.
  React.useEffect(() => {
    setComment("");
    setError(null);
    setProcessing(false);
  }, [edge?.id]);

  // Trap focus / close on Escape.
  React.useEffect(() => {
    if (!edge) return;
    closeRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [edge, onClose]);

  if (!edge) return null;

  const { label: confLabel, className: confClass } = confidenceLabel(edge.confidence);

  const handleDecision = async (decision: "approve" | "reject") => {
    setProcessing(true);
    setError(null);
    try {
      const res = await fetch(
        `${API_BASE}/v1/${orgSlug}/${workspaceSlug}/semantic-edges/${edge.id}/decide`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ decision, comment: comment.trim() || undefined }),
        },
      );
      if (!res.ok) {
        const msg = (await res.text()) || res.statusText;
        throw new Error(`Failed to ${decision} edge: ${msg}`);
      }
      onDecision(edge.id, decision);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setProcessing(false);
    }
  };

  return (
    // Backdrop
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay-scrim p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-xl border border-border/60 bg-card shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-border/40 px-5 py-4">
          <div className="flex flex-col gap-0.5">
            <h2 id="modal-title" className="text-base font-semibold text-foreground">
              Inferred Edge Review
            </h2>
            <p className="text-xs text-muted-foreground">
              Approve to materialise as a permanent knowledge-graph relationship.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close"
            className="flex-shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted transition-colors"
            onClick={onClose}
            disabled={processing}
          >
            <XCircle className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* Edge diagram */}
        <div className="flex items-center justify-center gap-2 border-b border-border/40 bg-muted/30 px-5 py-4">
          <span className="rounded-md border border-border/60 bg-card px-2.5 py-1 text-xs font-mono text-muted-foreground">
            {edge.sourceNodeId}
          </span>
          <ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <code className="rounded bg-primary/10 px-2.5 py-1 text-xs font-bold text-primary">
            {edge.type}
          </code>
          <ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <span className="rounded-md border border-border/60 bg-card px-2.5 py-1 text-xs font-semibold text-foreground">
            {edge.targetNodeId}
          </span>
        </div>

        {/* Metadata grid */}
        <div className="grid grid-cols-2 gap-4 px-5 py-4">
          <MetaRow label="Confidence">
            <span className={`font-semibold ${confClass}`}>
              {Math.round(edge.confidence * 100)}% ({confLabel})
            </span>
          </MetaRow>

          <MetaRow label="Connector">
            <span className="font-mono">{edge.source.connectorId}</span>
          </MetaRow>

          <MetaRow label="Inferred at">
            <span className="flex items-center gap-1 text-muted-foreground">
              <Clock className="h-3 w-3" aria-hidden="true" />
              {formatISO(edge.inferredAt)}
            </span>
          </MetaRow>

          <MetaRow label="Approval status">
            <span className={edge.approved ? "text-success font-semibold" : "text-muted-foreground"}>
              {edge.approved ? "Approved" : "Pending review"}
            </span>
          </MetaRow>

          {edge.approvedBy && (
            <MetaRow label="Approved by">
              <span className="flex items-center gap-1 text-muted-foreground">
                <Bot className="h-3 w-3" aria-hidden="true" />
                {edge.approvedBy}
              </span>
            </MetaRow>
          )}

          {edge.approvedAt && (
            <MetaRow label="Approved at">
              {formatISO(edge.approvedAt)}
            </MetaRow>
          )}
        </div>

        {/* Comment field — only shown for pending edges */}
        {!edge.approved && (
          <div className="border-t border-border/40 px-5 py-4">
            <label
              htmlFor="review-comment"
              className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
            >
              Comment (optional)
            </label>
            <Textarea
              id="review-comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Add a note for the audit trail…"
              rows={2}
              maxLength={1000}
              className="resize-none"
              disabled={processing}
            />
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="mx-5 mb-4 rounded-md border border-error/40 bg-error/12 px-3 py-2 text-xs text-error"
          >
            {error}
          </div>
        )}

        {/* Action footer */}
        {!edge.approved && (
          <div className="flex items-center justify-end gap-2 border-t border-border/40 px-5 py-4">
            <button
              type="button"
              className="rounded-md border border-border/60 bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted transition-colors"
              onClick={onClose}
              disabled={processing}
            >
              Cancel
            </button>
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-md border border-error/40 bg-error/12 px-3 py-1.5 text-xs font-semibold text-error hover:bg-error/20 transition-colors disabled:opacity-50"
              onClick={() => void handleDecision("reject")}
              disabled={processing}
            >
              {processing ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              Reject
            </button>
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
              onClick={() => void handleDecision("approve")}
              disabled={processing}
            >
              {processing ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              Approve edge
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
