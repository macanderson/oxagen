"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Archive, Bell, BellOff, Mail, MailOpen, Settings, Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { useNotifications } from "./notifications-context"
import type { Notification } from "@/lib/mock-data"
import { NotificationItem } from "./notification-item"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

type Tab = "inbox" | "archived"
type PendingDelete = { type: "ids"; ids: string[] } | { type: "all-archived" } | null

export function NotificationsBell() {
  const { inbox, archived, unreadCount, markRead, archive, remove, deleteAllArchived } =
    useNotifications()

  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>("inbox")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pendingDelete, setPendingDelete] = useState<PendingDelete>(null)

  const list: Notification[] = tab === "inbox" ? inbox : archived
  const selectedIds = useMemo(
    () => list.filter((n) => selected.has(n.id)).map((n) => n.id),
    [list, selected],
  )
  const selectedCount = selectedIds.length
  const allSelected = list.length > 0 && selectedCount === list.length

  function switchTab(next: Tab) {
    setTab(next)
    setSelected(new Set())
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    setSelected(allSelected ? new Set() : new Set(list.map((n) => n.id)))
  }

  function clearSelection() {
    setSelected(new Set())
  }

  function handleBulkRead(read: boolean) {
    markRead(selectedIds, read)
  }

  function handleBulkArchive() {
    archive(selectedIds)
    clearSelection()
  }

  function confirmDelete() {
    if (!pendingDelete) return
    if (pendingDelete.type === "all-archived") {
      deleteAllArchived()
    } else {
      remove(pendingDelete.ids)
    }
    clearSelection()
    setPendingDelete(null)
  }

  const deleteCount =
    pendingDelete?.type === "all-archived"
      ? archived.length
      : pendingDelete?.type === "ids"
        ? pendingDelete.ids.length
        : 0

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="relative size-9" aria-label="Notifications">
          <Bell className="size-[18px]" />
          {unreadCount > 0 && (
            <span
              aria-hidden="true"
              className="absolute right-1.5 top-1.5 grid size-4 place-items-center rounded-full bg-brand text-[10px] font-semibold text-brand-foreground"
            >
              {unreadCount}
            </span>
          )}
        </Button>
      </SheetTrigger>

      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="gap-1 border-b border-border px-5 py-4 text-left">
          <SheetTitle>Notifications</SheetTitle>
          <p className="text-sm text-muted-foreground">
            {unreadCount > 0 ? `${unreadCount} unread` : "You're all caught up"}
          </p>
        </SheetHeader>

        {/* Tabs */}
        <div className="border-b border-border px-5 py-3">
          <Tabs value={tab} onValueChange={(v) => switchTab(v as Tab)}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="inbox" className="gap-1.5">
                Inbox
                <span className="text-xs text-muted-foreground">{inbox.length}</span>
              </TabsTrigger>
              <TabsTrigger value="archived" className="gap-1.5">
                Archived
                <span className="text-xs text-muted-foreground">{archived.length}</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {/* Selection / bulk action toolbar */}
        {list.length > 0 && (
          <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-5 py-2">
            <Checkbox
              checked={allSelected}
              onCheckedChange={toggleSelectAll}
              aria-label="Select all notifications"
            />
            <span className="text-sm text-muted-foreground">
              {selectedCount > 0 ? `${selectedCount} selected` : "Select all"}
            </span>

            {selectedCount > 0 && (
              <div className="ml-auto flex items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5 px-2"
                  onClick={() => handleBulkRead(true)}
                >
                  <MailOpen className="size-4" />
                  <span className="hidden sm:inline">Read</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5 px-2"
                  onClick={() => handleBulkRead(false)}
                >
                  <Mail className="size-4" />
                  <span className="hidden sm:inline">Unread</span>
                </Button>
                {tab === "inbox" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 gap-1.5 px-2"
                    onClick={handleBulkArchive}
                  >
                    <Archive className="size-4" />
                    <span className="hidden sm:inline">Archive</span>
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5 px-2 text-muted-foreground hover:text-destructive"
                  onClick={() => setPendingDelete({ type: "ids", ids: selectedIds })}
                >
                  <Trash2 className="size-4" />
                  <span className="hidden sm:inline">Delete</span>
                </Button>
              </div>
            )}
          </div>
        )}

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {list.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-8 py-16 text-center">
              <span className="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
                <BellOff className="size-5" />
              </span>
              <div>
                <p className="text-sm font-medium">
                  {tab === "inbox" ? "Inbox zero" : "No archived notifications"}
                </p>
                <p className="text-sm text-muted-foreground">
                  {tab === "inbox"
                    ? "New notifications will show up here."
                    : "Archived notifications you keep will appear here."}
                </p>
              </div>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {list.map((n) => (
                <NotificationItem
                  key={n.id}
                  notification={n}
                  selected={selected.has(n.id)}
                  onToggleSelect={toggleSelect}
                  onMarkRead={(id, read) => markRead([id], read)}
                  onArchive={(id) => archive([id])}
                  onDelete={(id) => setPendingDelete({ type: "ids", ids: [id] })}
                />
              ))}
            </div>
          )}
        </div>

        {/* Archived footer: mass delete */}
        {tab === "archived" && archived.length > 0 && (
          <>
            <Separator />
            <div className="py-3 pl-5 pr-[4.5rem]">
              <Button
                variant="outline"
                className="w-full gap-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setPendingDelete({ type: "all-archived" })}
              >
                <Trash2 className="size-4" />
                Delete all archived ({archived.length})
              </Button>
            </div>
          </>
        )}

        {/* Settings shortcut: icon-only, lower-right corner */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              asChild
              variant="outline"
              size="icon"
              className="absolute bottom-4 right-4 size-10 rounded-full shadow-md"
            >
              <Link
                href="/account/notifications"
                onClick={() => setOpen(false)}
                aria-label="Manage notification settings"
              >
                <Settings className="size-[18px]" />
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">Manage notification settings</TooltipContent>
        </Tooltip>
      </SheetContent>

      {/* Delete confirmation (the only confirm flow) */}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingDelete?.type === "all-archived"
                ? `Delete all ${deleteCount} archived notifications?`
                : `Delete ${deleteCount} notification${deleteCount === 1 ? "" : "s"}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes{" "}
              {deleteCount === 1 ? "this notification" : "these notifications"}. This action cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  )
}
