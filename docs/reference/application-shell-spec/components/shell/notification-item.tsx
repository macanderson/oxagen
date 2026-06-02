"use client"

import {
  Archive,
  KeyRound,
  Mail,
  MailOpen,
  ShieldCheck,
  Trash2,
  UserPlus,
  Activity,
  Info,
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { Notification, NotificationKind } from "@/lib/mock-data"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

const KIND_ICON: Record<NotificationKind, typeof Info> = {
  approval: ShieldCheck,
  run: Activity,
  member: UserPlus,
  security: KeyRound,
  system: Info,
}

type Props = {
  notification: Notification
  selected: boolean
  onToggleSelect: (id: string) => void
  onMarkRead: (id: string, read: boolean) => void
  onArchive: (id: string) => void
  onDelete: (id: string) => void
}

export function NotificationItem({
  notification: n,
  selected,
  onToggleSelect,
  onMarkRead,
  onArchive,
  onDelete,
}: Props) {
  const Icon = KIND_ICON[n.kind]

  return (
    <div
      className={cn(
        "group relative flex gap-3 px-5 py-4 transition-colors",
        "hover:bg-muted/60",
        selected && "bg-muted",
      )}
    >
      <Checkbox
        checked={selected}
        onCheckedChange={() => onToggleSelect(n.id)}
        aria-label={`Select notification: ${n.title}`}
        className="mt-1"
      />

      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 grid size-8 shrink-0 place-items-center rounded-full",
          n.unread ? "bg-brand/10 text-brand" : "bg-muted text-muted-foreground",
        )}
      >
        <Icon className="size-4" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {n.unread && (
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-brand" />
          )}
          <p className={cn("truncate text-sm", n.unread ? "font-semibold" : "font-medium")}>
            {n.title}
          </p>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">{n.time}</span>
        </div>
        <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{n.body}</p>
      </div>

      {/* Hover / focus row actions */}
      <div className="absolute right-3 top-3 flex items-center gap-0.5 rounded-md border border-border bg-popover p-0.5 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => onMarkRead(n.id, n.unread)}
              aria-label={n.unread ? "Mark as read" : "Mark as unread"}
            >
              {n.unread ? <MailOpen className="size-4" /> : <Mail className="size-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{n.unread ? "Mark as read" : "Mark as unread"}</TooltipContent>
        </Tooltip>

        {!n.archived && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() => onArchive(n.id)}
                aria-label="Archive"
              >
                <Archive className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Archive</TooltipContent>
          </Tooltip>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-destructive"
              onClick={() => onDelete(n.id)}
              aria-label="Delete"
            >
              <Trash2 className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Delete</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
