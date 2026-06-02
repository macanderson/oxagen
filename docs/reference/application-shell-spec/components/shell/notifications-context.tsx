"use client"

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react"
import { notifications as seed, type Notification } from "@/lib/mock-data"

type NotificationsContextValue = {
  items: Notification[]
  inbox: Notification[]
  archived: Notification[]
  unreadCount: number
  // single-item actions
  markRead: (ids: string[], read: boolean) => void
  archive: (ids: string[]) => void
  remove: (ids: string[]) => void
  // bulk
  deleteAllArchived: () => void
}

const NotificationsContext = createContext<NotificationsContextValue | null>(null)

export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Notification[]>(() => seed.map((n) => ({ ...n })))

  const markRead = useCallback((ids: string[], read: boolean) => {
    const set = new Set(ids)
    setItems((prev) =>
      prev.map((n) => (set.has(n.id) ? { ...n, unread: !read } : n)),
    )
  }, [])

  const archive = useCallback((ids: string[]) => {
    const set = new Set(ids)
    setItems((prev) =>
      prev.map((n) => (set.has(n.id) ? { ...n, archived: true } : n)),
    )
  }, [])

  const remove = useCallback((ids: string[]) => {
    const set = new Set(ids)
    setItems((prev) => prev.filter((n) => !set.has(n.id)))
  }, [])

  const deleteAllArchived = useCallback(() => {
    setItems((prev) => prev.filter((n) => !n.archived))
  }, [])

  const value = useMemo<NotificationsContextValue>(() => {
    const inbox = items.filter((n) => !n.archived)
    const archivedItems = items.filter((n) => n.archived)
    return {
      items,
      inbox,
      archived: archivedItems,
      unreadCount: inbox.filter((n) => n.unread).length,
      markRead,
      archive,
      remove,
      deleteAllArchived,
    }
  }, [items, markRead, archive, remove, deleteAllArchived])

  return (
    <NotificationsContext.Provider value={value}>
      {children}
    </NotificationsContext.Provider>
  )
}

export function useNotifications() {
  const ctx = useContext(NotificationsContext)
  if (!ctx) throw new Error("useNotifications must be used within NotificationsProvider")
  return ctx
}
