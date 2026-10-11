// What the band shows and what it announces, as pure functions: grouping a
// burst, counting by level, deciding what is new, and reading a payload the
// API sent. Nothing here touches the engine, so it is all unit-testable.
import type { AlarumEvent, Level, Project, Scope, Workspace } from '../types'

export const LEVELS: Level[] = ['info', 'success', 'warn', 'error', 'critical']

/** Lowest to highest. A `minLevel` filter keeps everything at or above it. */
export const RANK: Record<Level, number> = { info: 0, success: 1, warn: 2, error: 3, critical: 4 }

/**
 * One glyph per level, all single-width: an emoji-presentation character (⛔,
 * 🔴) would take two cells in a terminal and shift every column after it.
 */
export const GLYPH: Record<Level, string> = { info: 'ℹ', success: '✓', warn: '!', error: '✖', critical: '⨳' }

/** The loud levels are drawn bold: it is what makes a bare `!` read as a warning. */
export const BOLD: Record<Level, boolean> = { info: false, success: false, warn: true, error: true, critical: true }

/**
 * The web inbox's own colours (composables/useLevels.ts), to the digit, so a
 * level is the same colour in the terminal as in the browser. Spelled rgb(),
 * as a theme spells its colours: the same value as a hex came out duller in
 * some terminals.
 */
export const COLOR: Record<Level, string> = {
  info: 'rgb(52,152,219)',     // #3498DB
  success: 'rgb(46,204,113)',  // #2ECC71
  warn: 'rgb(230,126,34)',     // #E67E22
  error: 'rgb(231,76,60)',     // #E74C3C
  critical: 'rgb(155,89,182)', // #9B59B6
}

/** A row of the band: an event, plus how many identical ones it stands for. */
export type Row = AlarumEvent & { repeats: number }

const isLevel = (v: unknown): v is Level => typeof v === 'string' && (LEVELS as string[]).includes(v)

/**
 * One event from the API's JSON, or null when the shape is not what we expect.
 * Defensive on purpose: a band that throws on one odd row would take the whole
 * list down with it.
 */
export function toEvent(raw: unknown): AlarumEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || typeof r.title !== 'string' || !isLevel(r.level)) return null
  const project = (r.project ?? {}) as Record<string, unknown>
  const fields = Array.isArray(r.fields) ? r.fields : []
  return {
    id: r.id,
    level: r.level,
    title: r.title,
    message: typeof r.message === 'string' && r.message !== '' ? r.message : null,
    source: typeof r.source === 'string' && r.source !== '' ? r.source : null,
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string') : [],
    fields: fields
      .map(f => (f && typeof f === 'object' ? f as Record<string, unknown> : {}))
      .filter(f => typeof f.name === 'string' && typeof f.value === 'string')
      .map(f => ({ name: String(f.name), value: String(f.value) })),
    receivedAt: typeof r.receivedAt === 'number' ? r.receivedAt : 0,
    read: r.read === true,
    projectId: typeof project.id === 'string' ? project.id : '',
    projectName: typeof project.name === 'string' ? project.name : '',
    workspaceId: typeof project.workspaceId === 'string' ? project.workspaceId : '',
    url: typeof r.url === 'string' ? r.url : null,
    webUrl: typeof r.webUrl === 'string' ? r.webUrl : null,
  }
}

/**
 * Fold CONSECUTIVE repeats into one row carrying a count. Only neighbours are
 * folded, so the list stays in true chronological order: a burst collapses, an
 * event that comes back an hour later keeps its own line.
 */
export function group(events: AlarumEvent[]): Row[] {
  const rows: Row[] = []
  for (const e of events) {
    const last = rows[rows.length - 1]
    if (last && last.title === e.title && last.source === e.source && last.level === e.level && last.projectId === e.projectId) {
      // The newest of the burst keeps the row (the list is newest first), and
      // an unread one in the group marks the row unread.
      last.repeats += 1
      last.read = last.read && e.read
      continue
    }
    rows.push({ ...e, repeats: 1 })
  }
  return rows
}

/** How many events of each level, for the folded band's one line. */
export function counts(events: AlarumEvent[]): Record<Level, number> {
  const out: Record<Level, number> = { info: 0, success: 0, warn: 0, error: 0, critical: 0 }
  for (const e of events) out[e.level] += 1
  return out
}

/** What the filters leave: a level that is on, and unread when that is asked. */
export function visible(events: AlarumEvent[], levels: Level[], unreadOnly: boolean): AlarumEvent[] {
  return events.filter(e => levels.includes(e.level) && (!unreadOnly || !e.read))
}

export function newestAt(events: AlarumEvent[]): number {
  return events.reduce((max, e) => (e.receivedAt > max ? e.receivedAt : max), 0)
}

/**
 * What to toast: events that arrived after the baseline, whose level the
 * account asked to be notified about for THEIR project, AND which the filters
 * leave on screen. Filtering down to errors means "only this", interruptions
 * included; a filter can only ever take announcements away, never add one the
 * project's rules refuse.
 *
 * `override` (the `levels=` line) replaces the project's rules when set, and
 * the shown levels still apply on top.
 *
 * A project the listing did not carry (a token that cannot reach it, a listing
 * that failed) announces nothing rather than guessing: a silent band is a
 * smaller surprise than one that shouts about the wrong thing.
 */
export function announce(
  events: AlarumEvent[],
  seenUpTo: number,
  projects: Project[],
  override: Level[],
  shown: Level[],
): AlarumEvent[] {
  if (seenUpTo === 0) return [] // first load: the window is the baseline, not news
  const push = new Map(projects.map(p => [p.id, p.push]))
  return events
    .filter(e => e.receivedAt > seenUpTo)
    .filter(e => shown.includes(e.level))
    .filter(e => (override.length ? override.includes(e.level) : push.get(e.projectId)?.[e.level] === true))
    .sort((a, b) => a.receivedAt - b.receivedAt)
}

/** A message's first line, for the row that shows it without expanding. */
export function firstLine(message: string): string {
  const line = message.split('\n').find(l => l.trim() !== '') ?? ''
  return line.trim()
}

/** '2m', '3h', '4d': an age a glance can read, counted from `nowMs`. */
export function ago(receivedAt: number, nowMs: number): string {
  const s = Math.max(0, Math.round(nowMs / 1000) - receivedAt)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/**
 * The scope, applied HERE rather than in the query. Every session reads the
 * same account-wide window so they can share one request (#695), and each one
 * then keeps what its own scope covers.
 */
export function inScope(events: AlarumEvent[], scope: Scope): AlarumEvent[] {
  if (scope.kind === 'all') return events
  if (scope.kind === 'project') return events.filter(e => e.projectId === scope.id)
  return events.filter(e => e.workspaceId === scope.id)
}

/** How the scope reads in the band's header. */
export function scopeLabel(scope: Scope, projects: Project[], workspaces: Workspace[]): string {
  if (scope.kind === 'project') return projects.find(p => p.id === scope.id)?.name ?? 'project'
  if (scope.kind === 'workspace') return workspaces.find(w => w.id === scope.id)?.name ?? 'workspace'
  return 'All projects'
}

/**
 * A scope naming a project or workspace by id OR by slug / name, turned into
 * one naming it by id, or null when nothing matches. `.alarum` is written by
 * hand, so `project=alarum` has to work as well as a copied uuid.
 */
export function resolveScope(scope: Scope, projects: Project[], workspaces: Workspace[]): Scope | null {
  if (scope.kind === 'all') return scope
  if (scope.kind === 'project') {
    const p = projects.find(x => x.id === scope.id) ?? projects.find(x => x.slug === scope.id)
    return p ? { kind: 'project', id: p.id } : null
  }
  const w = workspaces.find(x => x.id === scope.id)
    ?? workspaces.find(x => x.name.toLowerCase() === scope.id.toLowerCase())
  return w ? { kind: 'workspace', id: w.id } : null
}

/**
 * The scope the band opens on: what was chosen here before, else what `.alarum`
 * names, and `all` when neither resolves any more (a revoked share, a renamed
 * project) rather than an empty band with nothing to explain it.
 */
export function openingScope(stored: unknown, fromFile: Scope, projects: Project[], workspaces: Workspace[]): Scope {
  if (stored && typeof stored === 'object') {
    const s = stored as Scope
    if (s.kind === 'all' || s.kind === 'project' || s.kind === 'workspace') {
      const found = resolveScope(s, projects, workspaces)
      if (found) return found
    }
  }
  return resolveScope(fromFile, projects, workspaces) ?? { kind: 'all' }
}
