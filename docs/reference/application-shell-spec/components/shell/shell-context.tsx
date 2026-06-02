"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"

type LastWorkspace = { org: string; ws: string } | null
export type RecentWorkspace = { org: string; ws: string }

type ShellContextValue = {
  // Ask drawer (persists across navigation within a session — spec §7)
  askOpen: boolean
  askEntity: string | null
  openAsk: (entity?: string | null) => void
  closeAsk: () => void
  // Mobile sidebar drawer
  mobileNavOpen: boolean
  setMobileNavOpen: (open: boolean) => void
  // Last-viewed workspace per device (spec §10)
  lastWorkspace: LastWorkspace
  setLastWorkspace: (ws: LastWorkspace) => void
  // Recently-visited workspaces, most-recent first (workspace switcher recents)
  recentWorkspaces: RecentWorkspace[]
  pushRecentWorkspace: (ws: RecentWorkspace) => void
  // Return path for account-mode "Back to app" entry/exit preservation
  returnPath: string | null
  setReturnPath: (path: string | null) => void
}

const ShellContext = createContext<ShellContextValue | null>(null)

const STORAGE_KEY = "oxagen.lastWorkspace"
const RECENTS_KEY = "oxagen.recentWorkspaces"
const RETURN_KEY = "oxagen.returnPath"
const MAX_RECENTS = 5

export function ShellProvider({ children }: { children: React.ReactNode }) {
  const [askOpen, setAskOpen] = useState(false)
  const [askEntity, setAskEntity] = useState<string | null>(null)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [lastWorkspace, setLastWorkspaceState] = useState<LastWorkspace>(null)
  const [recentWorkspaces, setRecentWorkspaces] = useState<RecentWorkspace[]>([])
  const [returnPath, setReturnPathState] = useState<string | null>(null)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) setLastWorkspaceState(JSON.parse(raw))
      const recents = localStorage.getItem(RECENTS_KEY)
      if (recents) setRecentWorkspaces(JSON.parse(recents))
      const rp = sessionStorage.getItem(RETURN_KEY)
      if (rp) setReturnPathState(rp)
    } catch {
      // ignore
    }
  }, [])

  const setLastWorkspace = useCallback((ws: LastWorkspace) => {
    setLastWorkspaceState(ws)
    try {
      if (ws) localStorage.setItem(STORAGE_KEY, JSON.stringify(ws))
    } catch {
      // ignore
    }
  }, [])

  const pushRecentWorkspace = useCallback((ws: RecentWorkspace) => {
    setRecentWorkspaces((prev) => {
      const next = [ws, ...prev.filter((w) => !(w.org === ws.org && w.ws === ws.ws))].slice(
        0,
        MAX_RECENTS,
      )
      try {
        localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
      } catch {
        // ignore
      }
      return next
    })
  }, [])

  const setReturnPath = useCallback((path: string | null) => {
    setReturnPathState(path)
    try {
      if (path) sessionStorage.setItem(RETURN_KEY, path)
      else sessionStorage.removeItem(RETURN_KEY)
    } catch {
      // ignore
    }
  }, [])

  const openAsk = useCallback((entity?: string | null) => {
    setAskEntity(entity ?? null)
    setAskOpen(true)
  }, [])

  const closeAsk = useCallback(() => setAskOpen(false), [])

  const value = useMemo(
    () => ({
      askOpen,
      askEntity,
      openAsk,
      closeAsk,
      mobileNavOpen,
      setMobileNavOpen,
      lastWorkspace,
      setLastWorkspace,
      recentWorkspaces,
      pushRecentWorkspace,
      returnPath,
      setReturnPath,
    }),
    [
      askOpen,
      askEntity,
      openAsk,
      closeAsk,
      mobileNavOpen,
      lastWorkspace,
      setLastWorkspace,
      recentWorkspaces,
      pushRecentWorkspace,
      returnPath,
      setReturnPath,
    ],
  )

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>
}

export function useShell() {
  const ctx = useContext(ShellContext)
  if (!ctx) throw new Error("useShell must be used within ShellProvider")
  return ctx
}
