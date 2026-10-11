export type Level = 'info' | 'success' | 'warn' | 'error' | 'critical'

/** One event as /api/v1/events publishes it, trimmed to what the band draws. */
export type AlarumEvent = {
  id: string
  level: Level
  title: string
  message: string | null
  source: string | null
  tags: string[]
  fields: { name: string; value: string }[]
  /** Unix seconds, as the API reports them. */
  receivedAt: number
  read: boolean
  projectId: string
  projectName: string
  /** Its project's workspace, so a workspace scope can be applied locally. */
  workspaceId: string
  /** The link the sender attached, if any. */
  url: string | null
  /** The event's page in the web app. */
  webUrl: string | null
}

/**
 * A project the token can reach. `push` is what the account asked to be
 * notified about for it, and is what the band toasts on.
 */
export type Project = {
  id: string
  workspaceId: string
  workspaceName: string
  name: string
  /** What a hand-written `.alarum` is likely to name the project by. */
  slug: string
  unreadCount: number
  push: Record<Level, boolean>
}

export type Workspace = { id: string; name: string; unreadCount: number }

/** What the band is looking at: everything, one workspace, or one project. */
export type Scope = { kind: 'all' } | { kind: 'workspace'; id: string } | { kind: 'project'; id: string }

declare module 'claude-code' {
  interface PluginState {
    alarum: {
      /** The window the band draws, newest first. */
      events: AlarumEvent[]
      /** Everything the token can reach, for the scope picker and the push rules. */
      projects: Project[]
      workspaces: Workspace[]
      scope: Scope
      /** Last fetch problem shown in the band, null when fine. */
      error: string | null
      /** A model turn is running: the band reads less often. */
      isBusy: boolean
      /** The scope picker replaces the list while it is open. */
      isPickingScope: boolean
      layout: 'band' | 'pane'
      /** The event whose detail the pane draws. */
      selected: string | null
      /** The levels drawn, one chip each, as the web inbox filters them. */
      levels: Level[]
      unreadOnly: boolean
      /** When a rate-limit pause (429) ends, in ms; 0 when none. */
      pausedUntil: number
      /** receivedAt of the newest event already announced: the toast baseline. */
      seenUpTo: number
      /** The time the band last ticked, in ms: what the ages are counted to. */
      now: number
    }
  }
}
