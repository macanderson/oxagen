"use client";
/**
 * SupportMenu — the header Support affordance.
 *
 * A small icon button (next to the notifications bell) that opens an animated
 * dropdown of help resources: documentation links, a one-click "Chat with the
 * AI assistant", a contact-support mailto, and a footer with the company name,
 * locale, and support mailbox. The MenuPopup carries the design-system overlay
 * transition (scale + fade), so no extra motion wiring is needed.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { LifeBuoy, BookOpen, Mail, Sparkles, ExternalLink } from "lucide-react";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuGroupLabel,
  MenuSeparator,
} from "@/components/ui/menu";
import { Button } from "@/components/ui/button";
import { workspace } from "@/lib/routes";
import {
  SUPPORT_LINKS,
  SUPPORT_EMAIL,
  COMPANY_NAME,
  COMPANY_ADDRESS,
} from "./support";

export interface SupportMenuProps {
  /** Current org slug, when inside an org — drives the AI-assistant route. */
  orgSlug?: string;
  /** Current workspace slug, when inside a workspace. */
  workspaceSlug?: string;
}

export function SupportMenu({ orgSlug, workspaceSlug }: SupportMenuProps) {
  const router = useRouter();

  // "Chat with the AI assistant" routes to the workspace Sessions surface (the
  // product's AI agent). Fall back to the org root, then app root, so the
  // item is always actionable regardless of where it's opened from.
  const chatHref =
    orgSlug && workspaceSlug
      ? workspace.sessions({ orgSlug, workspaceSlug })
      : orgSlug
        ? `/${orgSlug}`
        : "/";

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label="Help and support"
            className="text-app-link-fg hover:text-app-link-hover-fg max-md:size-11"
          />
        }
      >
        <LifeBuoy className="size-4" />
      </MenuTrigger>
      <MenuPopup align="end" className="w-72">
        <MenuGroupLabel>Support</MenuGroupLabel>

        <MenuItem onClick={() => router.push(chatHref)} className="gap-2 py-2">
          <Sparkles className="size-4 text-primary" />
          <div className="flex flex-col">
            <span className="text-sm">Chat with the AI assistant</span>
            <span className="text-xs text-muted-foreground">
              Ask a question, get an answer now
            </span>
          </div>
        </MenuItem>

        <MenuSeparator />

        {SUPPORT_LINKS.map((link) => (
          <MenuItem
            key={link.href}
            className="gap-2 py-2"
            render={
              <a
                href={link.href}
                {...(link.external
                  ? { target: "_blank", rel: "noreferrer" }
                  : {})}
              />
            }
          >
            <BookOpen className="size-4 text-muted-foreground" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-center gap-1 text-sm">
                {link.label}
                {link.external ? (
                  <ExternalLink className="size-3 text-muted-foreground" />
                ) : null}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {link.description}
              </span>
            </div>
          </MenuItem>
        ))}

        <MenuItem
          className="gap-2 py-2"
          render={<a href={`mailto:${SUPPORT_EMAIL}`} />}
        >
          <Mail className="size-4 text-muted-foreground" />
          <div className="flex flex-col">
            <span className="text-sm">Contact support</span>
            <span className="text-xs text-muted-foreground">
              {SUPPORT_EMAIL}
            </span>
          </div>
        </MenuItem>

        <MenuSeparator />

        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">{COMPANY_NAME}</p>
          <p>{COMPANY_ADDRESS}</p>
          <p>{SUPPORT_EMAIL}</p>
        </div>
      </MenuPopup>
    </Menu>
  );
}
