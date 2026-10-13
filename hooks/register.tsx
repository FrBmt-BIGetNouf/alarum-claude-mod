// Glyphs: ⨳ Alarum; levels ℹ info, ✓ success, ⚠ warn, ✕ error, ⛔ critical;
// actions ⤴ investigate, ✓ mark read, ⌕ open, ⟳ refresh, ⊙ scope, + - fold.
//
// Alarum mod: the account's events, live, in a band above the prompt or in a
// side pane. It reads them through the agent API (/api/v1, an account token in
// `.alarum`), which also lets it mark them read, so what you clear in the
// terminal is cleared in the web inbox.
//
// What it is NOT: a second inbox. It shows what arrives while you work, and
// hands an event to the agent (⤴) when it deserves a look. Anything older than
// the window belongs in the app.
//
// Three things it refuses to do, all for one reason (the token reads every
// project of the account): the agent never reads `.alarum`, any token in a
// tool's output is masked, and nothing from that file ever reaches $.state.
//
// No `.alarum` in the repo: no band, no request, nothing drawn. The mod is
// installed once and must not follow you into repositories that do not use it.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderNode } from 'claude-code'

import type { AlarumEvent, Level, Project, Scope, Workspace } from '../types'
import { parseConfig } from './config'
import type { Config } from './config'
import { mask, refusal, TOKEN_RE } from './guards'
import { investigatePrompt } from './investigate'
import {
  ago, announce, BOLD, COLOR, firstLine, GLYPH, group, LEVELS, newestAt,
  inScope, openingScope, scopeLabel, toEvent, visible,
} from './events'
import type { Row } from './events'

const PANE = 'alarum'
const TOAST = { timeoutMs: 8000 }

const SHOWN = 6          // rows the band draws before "+N more"
const WINDOW = 120       // events asked for: one account-wide window for every session (#695)
const NARROW = 100       // band columns below which the header labels shrink to a glyph
const NARROW_PANE = 60
const TIGHT = 132        // and below which a row's own labels do, a row carrying more of them
const TIGHT_PANE = 78
const TICK_MS = 5_000    // how often the clock is consulted, not how often we read

// Alarum's orange, the band's frame and title. Spelled rgb(), as a theme
// spells its colours: the same value as a hex came out duller in some
// terminals. On a light background the brand orange washes out against white,
// so a deeper amber stands in; everything else is left to the theme.
const ORANGE = 'rgb(245,166,35)'
const AMBER = 'rgb(176,106,0)'
let brand = ORANGE
async function readBrand($: EngineInterface) {
  const rows = await $.config.list().catch(() => [])
  const theme = rows.find(row => row.key === 'theme')?.value
  brand = typeof theme === 'string' && theme.startsWith('light') ? AMBER : ORANGE
}

const events = atom({ plugin: 'alarum', key: 'events' } as const, [])
const projects = atom({ plugin: 'alarum', key: 'projects' } as const, [])
const workspaces = atom({ plugin: 'alarum', key: 'workspaces' } as const, [])
const scope = atom({ plugin: 'alarum', key: 'scope' } as const, { kind: 'all' })
const error = atom({ plugin: 'alarum', key: 'error' } as const, null)
const isBusy = atom({ plugin: 'alarum', key: 'isBusy' } as const, false)
const isPickingScope = atom({ plugin: 'alarum', key: 'isPickingScope' } as const, false)
const layout = atom({ plugin: 'alarum', key: 'layout' } as const, 'band')
const selected = atom({ plugin: 'alarum', key: 'selected' } as const, null)
const levels = atom({ plugin: 'alarum', key: 'levels' } as const, LEVELS)
const unreadOnly = atom({ plugin: 'alarum', key: 'unreadOnly' } as const, false)
const pausedUntil = atom({ plugin: 'alarum', key: 'pausedUntil' } as const, 0)
const seenUpTo = atom({ plugin: 'alarum', key: 'seenUpTo' } as const, 0)
const now = atom({ plugin: 'alarum', key: 'now' } as const, 0)

// The repo's config; module-local, never in $.state.
let config: Config | null = null
// Where the `.alarum` was found, as the key everything remembered hangs off.
let repoKey = ''
// When the list was last read, until when the API asked us to wait (429), and
// whether the plan refusal has already been said once.
let lastRefresh = 0
let quietUntil = 0
let saidPlan = false

// ── Setup ───────────────────────────────────────────────────────────────────

// Walking up from the session's directory, like a CLI would. Windows paths too
// (Claude Desktop): `C:\Workspace\repo`, its own separator kept.
async function findConfig($: EngineInterface): Promise<Config | null> {
  let dir = await $.session.cwd()
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  for (let i = 0; i < 30; i++) {
    const path = `${dir}${sep}.alarum`
    if (await $.fs.exists(path)) {
      repoKey = dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      return parseConfig(await $.fs.read(path))
    }
    const up = dir.replace(/[\\/][^\\/]+$/, '')
    if (!up || up === dir) return null
    dir = up
  }
  return null
}

// ── What the mod remembers ──────────────────────────────────────────────────
// $.store is one JSON file per plugin under the user's Claude Code directory,
// so it outlives the session AND is shared by every session on this machine.
// That cuts both ways: preferences have to be told apart per repo, and the
// event window is worth sharing on purpose (#695).

async function remember($: EngineInterface, key: string, value: unknown) {
  await $.store.set(`${repoKey}:${key}`, value).catch(() => undefined)
}

async function recall($: EngineInterface, key: string): Promise<unknown> {
  const own = await $.store.get(`${repoKey}:${key}`).catch(() => undefined)
  if (own !== undefined && own !== null) return own
  // Earlier versions kept one value for every repo at once: read it once so a
  // choice already made is not thrown away.
  return $.store.get(key).catch(() => undefined)
}

// ── The shared window (#695) ────────────────────────────────────────────────
// Four to six sessions, each reading the same events every 20 seconds, is the
// same answer fetched six times. They now share one window through the store:
// whoever finds it stale fetches, the others read what it left.
//
// Keyed by the ACCOUNT, never by the repo: two repos holding two different
// tokens must not see each other's events. The key is a hash of the API and
// the token, so the token itself never reaches the store, and nothing of it
// can be read back out of a 32-bit digest.
let fingerprint = ''

function fingerprintOf(c: Config): string {
  let h = 0x811c9dc5 // FNV-1a, enough to name a bucket, not a signature
  const material = `${c.api}\n${c.token}`
  for (let i = 0; i < material.length; i++) {
    h ^= material.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

async function readShared($: EngineInterface, key: string): Promise<unknown> {
  return $.store.get(`shared:${fingerprint}:${key}`).catch(() => undefined)
}

async function writeShared($: EngineInterface, key: string, value: unknown) {
  await $.store.set(`shared:${fingerprint}:${key}`, value).catch(() => undefined)
}

/** A shared entry still worth reading, or null. */
function fresh(entry: unknown, now: number, ttlMs: number): { at: number; value: unknown } | null {
  if (!entry || typeof entry !== 'object') return null
  const e = entry as { at?: unknown; value?: unknown }
  if (typeof e.at !== 'number' || now - e.at >= ttlMs || now < e.at) return null
  return { at: e.at, value: e.value }
}

// ── The API ─────────────────────────────────────────────────────────────────

type Answer = { ok: true; json: unknown } | null

/**
 * One call to the agent API. Every failure becomes something the band can say
 * in one line: a band that silently stops updating is exactly the failure this
 * whole mod exists to avoid.
 */
async function call($: EngineInterface, path: string, init: { method?: string; body?: unknown } = {}): Promise<Answer> {
  if (!config) return null
  let res
  try {
    res = await $.http.fetch(`${config.api}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
  } catch {
    await update($, error, () => 'offline, retrying')
    return null
  }

  if (res.status === 401) {
    await update($, error, () => 'token refused: check token= in .alarum')
    return null
  }
  if (res.status === 403) {
    // The plan lost the agent API (a downgrade, an expired subscription). Said
    // once: repeating it every 30 seconds would be its own kind of noise.
    const plan = /plan_required/.test(res.text)
    await update($, error, () => (plan ? 'the agent API needs a paid plan' : 'no access to that project'))
    if (plan && !saidPlan) {
      saidPlan = true
      $.ui.toast('Alarum: the agent API is part of the paid plans. The band stays empty until the account has one.', TOAST)
    }
    return null
  }
  if (res.status === 429) {
    // Wait as told; the band keeps what it already shows.
    const wait = Number(res.headers['retry-after'] ?? 60)
    const at = await $.clock.now().catch(() => lastRefresh)
    quietUntil = at + (Number.isFinite(wait) ? wait : 60) * 1000
    await update($, pausedUntil, () => quietUntil)
    return null
  }
  if (!res.ok) {
    await update($, error, () => `error ${res.status}`)
    return null
  }

  await update($, pausedUntil, () => 0)
  try {
    return { ok: true, json: res.text ? JSON.parse(res.text) : null }
  } catch {
    await update($, error, () => 'unreadable response')
    return null
  }
}

const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback)
const num = (v: unknown) => (typeof v === 'number' ? v : 0)

/** The scope lists: what the picker offers, and the push rules the toasts obey. */
/**
 * The scope lists: what the picker offers, and the push rules the toasts obey.
 * Shared like the window, and kept longer: projects and workspaces change by
 * the week, and the unread counts they carry are refreshed on every write.
 */
const SCOPES_TTL = 300_000

async function loadScopes($: EngineInterface, opts: { force?: boolean } = {}) {
  const at = await $.clock.now().catch(() => lastRefresh)
  if (!opts.force) {
    const hit = fresh(await readShared($, 'scopes'), at, SCOPES_TTL)
    const held = hit?.value as { projects?: Project[]; workspaces?: Workspace[] } | undefined
    if (held && Array.isArray(held.projects) && Array.isArray(held.workspaces)) {
      await update($, projects, () => held.projects as Project[])
      await update($, workspaces, () => held.workspaces as Workspace[])
      return
    }
  }

  const [ps, ws] = await Promise.all([call($, '/projects'), call($, '/workspaces')])
  if (ps) {
    const rows = (ps.json as { projects?: unknown[] })?.projects ?? []
    const list = rows.map((raw): Project => {
      const r = raw as Record<string, unknown>
      const push = (r.push ?? {}) as Record<string, unknown>
      return {
        id: str(r.id), workspaceId: str(r.workspaceId), workspaceName: str(r.workspaceName),
        name: str(r.name), slug: str(r.slug), unreadCount: num(r.unreadCount),
        push: Object.fromEntries(LEVELS.map(l => [l, push[l] === true])) as Record<Level, boolean>,
      }
    })
    await update($, projects, () => list)
  }
  if (ws) {
    const rows = (ws.json as { workspaces?: unknown[] })?.workspaces ?? []
    const list = rows.map((raw): Workspace => {
      const r = raw as Record<string, unknown>
      return { id: str(r.id), name: str(r.name), unreadCount: num(r.unreadCount) }
    })
    await update($, workspaces, () => list)
  }

  // Only a pair that both arrived is worth leaving for the others.
  if (ps && ws) {
    await writeShared($, 'scopes', {
      at,
      value: { projects: await read($, projects), workspaces: await read($, workspaces) },
    })
  }
}

/**
 * Read the window and announce what is new.
 *
 * The WHOLE window is read each time, not the delta since the newest event: a
 * delta costs the same one request against the per-minute cap, and drifts away
 * from events read, deleted or marked elsewhere. Correctness for the same price.
 */
/**
 * Take a window, announce what is new in THIS session's scope, and hold it.
 *
 * The window is account-wide and the scope is applied here, so every session
 * can read the same one. Announcing is per session all the same: each keeps
 * its own `seenUpTo`, and a session looking at one project does not toast
 * another's events.
 */
async function hold($: EngineInterface, list: AlarumEvent[]) {
  if (!config) return
  const where = await read($, scope)
  const baseline = await read($, seenUpTo)
  const news = announce(inScope(list, where), baseline, await read($, projects), config.levels, await read($, levels))
  for (const e of news) $.ui.toast(`${GLYPH[e.level]} ${e.projectName}: ${e.title}`, TOAST)

  // The baseline moves with the WHOLE window, not the scoped part: what was on
  // screen under another scope is not news when the scope comes back to it.
  const newest = newestAt(list)
  await update($, seenUpTo, prev => (newest > prev ? newest : prev))
  await update($, events, () => list)
  await update($, error, () => null)
  await syncPaneTitle($)
}

/**
 * Read the window, from the store when another session has just read it.
 *
 * `force` skips the shared copy, for the moments where staleness would be a
 * lie: a press on Refresh, and right after a write of our own.
 */
async function refresh($: EngineInterface, opts: { force?: boolean } = {}) {
  if (!config) return
  const at = await $.clock.now().catch(() => lastRefresh)
  await update($, now, () => at)
  lastRefresh = at
  if (at < quietUntil) return

  if (!opts.force) {
    const hit = fresh(await readShared($, 'events'), at, config.poll * 1000)
    if (hit && Array.isArray(hit.value)) {
      await hold($, hit.value as AlarumEvent[])
      return
    }
  }

  // No scope in the query on purpose: one window for every session (#695).
  const answer = await call($, `/events?limit=${WINDOW}`)
  if (!answer) return

  const rows = (answer.json as { events?: unknown[] })?.events ?? []
  const list = rows.map(toEvent).filter((e): e is AlarumEvent => e !== null)

  await writeShared($, 'events', { at, value: list })
  await hold($, list)
}

// ── Actions ─────────────────────────────────────────────────────────────────

/**
 * A write of our own makes every shared copy a lie: the other sessions would
 * go on drawing an event as unread for up to a poll. Dropping the stamps makes
 * the next tick of each of them read the API again.
 */
async function invalidate($: EngineInterface) {
  await writeShared($, 'events', null)
  await writeShared($, 'scopes', null)
}

async function markRead($: EngineInterface, id: string, next: boolean) {
  // Drawn at once, then confirmed: a tick that waits for the network feels broken.
  await update($, events, list => list.map(e => (e.id === id ? { ...e, read: next } : e)))
  await syncPaneTitle($)
  const answer = await call($, `/events/${encodeURIComponent(id)}/read`, { method: next ? 'POST' : 'DELETE' })
  if (!answer) {
    await update($, events, list => list.map(e => (e.id === id ? { ...e, read: !next } : e)))
    await syncPaneTitle($)
    return
  }
  await invalidate($)
  await loadScopes($, { force: true })
}

async function markAllRead($: EngineInterface) {
  const where = await read($, scope)
  const body = where.kind === 'all' ? { scope: 'all' } : { scope: where.kind, id: where.id }
  const answer = await call($, '/events/read-all', { method: 'POST', body })
  if (!answer) { $.ui.toast('Alarum: could not mark them read'); return }
  await update($, events, list => list.map(e => (inScope([e], where).length ? { ...e, read: true } : e)))
  await syncPaneTitle($)
  await invalidate($)
  await loadScopes($, { force: true })
}

async function setScope($: EngineInterface, next: Scope) {
  await update($, scope, () => next)
  await update($, isPickingScope, () => false)
  await update($, selected, () => null)
  await remember($, 'scope', next)
  await syncPaneTitle($)
  // No refetch: the window held covers every project, so a new scope is a new
  // filter over what is already here.
}

/**
 * One level chip on or off. The last one on cannot be turned off: an empty
 * filter draws an empty band with nothing to say why, and the way to see
 * nothing is to close the pane.
 */
async function toggleLevel($: EngineInterface, level: Level) {
  const on = await read($, levels)
  const next = on.includes(level) ? on.filter(l => l !== level) : [...on, level]
  if (!next.length) { $.ui.toast('Alarum: at least one level has to stay on'); return }
  const ordered = LEVELS.filter(l => next.includes(l))
  await update($, levels, () => ordered)
  await remember($, 'levels', ordered)
  await syncPaneTitle($)
}

async function toggleUnread($: EngineInterface) {
  const next = !(await read($, unreadOnly))
  await update($, unreadOnly, () => next)
  await remember($, 'unread', next)
}

/** ⤴: the event goes into the prompt box, unsent, after whatever is typed. */
async function investigate($: EngineInterface, event: AlarumEvent) {
  const text = investigatePrompt(event)
  const box = await $.prompt.read().catch(() => ({ text: '' }))
  const filled = await $.prompt
    .fill({ text: box.text.trim() ? `\n\n${text}` : text, mode: 'append' })
    .catch(() => ({ isFilled: false }))
  if (!filled.isFilled) $.ui.toast('Alarum: the prompt box would not take it (a dialog is up?)')
}

// Open a URL with the host's own opener: no shell, the URL one argument. WSL
// hands it to Windows (explorer.exe exits 1 even when it opened it); Windows,
// macOS and Linux their usual one.
async function openPage($: EngineInterface, url: string) {
  const openers: string[][] = []
  if (await $.env.get('WSL_DISTRO_NAME')) openers.push(['explorer.exe', url], ['wslview', url])
  else if (await $.env.get('OS') === 'Windows_NT') openers.push(['rundll32', 'url.dll,FileProtocolHandler', url])
  else {
    const os = await $.process.run(['uname', '-s']).then(r => r.stdout.trim(), () => '')
    openers.push(os === 'Darwin' ? ['open', url] : ['xdg-open', url])
  }
  for (const argv of openers) {
    try {
      const { exitCode } = await $.process.run(argv, { timeoutMs: 10_000 })
      if (exitCode === 0 || argv[0] === 'explorer.exe') return
    } catch { /* not there: the next one */ }
  }
  $.ui.toast(`Alarum: could not open a browser for ${url}`)
}

/** Which of the two the mod draws into, kept for the next session of this repo. */
async function saveLayout($: EngineInterface, next: 'band' | 'pane') {
  await update($, layout, () => next)
  await remember($, 'layout', next)
}

/**
 * The pane's tab: `Alarum`, or `Alarum (3)` while three events the filters
 * leave are unread. The tab is all that is left of the mod when another
 * plugin's pane is in front, so the count belongs there.
 *
 * Counted like the band's counters: events, not the rows a burst folds into,
 * and under the scope and the levels in force, which is what is being looked at.
 */
async function paneTitle($: EngineInterface): Promise<string> {
  const where = await read($, scope)
  const unread = visible(inScope(await read($, events), where), await read($, levels), true).length
  return unread ? `Alarum (${unread})` : 'Alarum'
}

/**
 * Deliver that title, if it changed.
 *
 * Opening an id already open retitles it in place, so this is the whole of it.
 * Called from what moves the count, never from drawing: a render hook may not
 * write, and a retitle would redraw what is drawing.
 */
async function syncPaneTitle($: EngineInterface) {
  const open = (await $.ui.panes().catch(() => [])).find(p => p.id === PANE)
  if (!open) return
  const title = await paneTitle($)
  if (open.title === title) return
  await $.ui.open({ id: PANE, title }).catch(() => undefined)
}

async function toggleLayout($: EngineInterface) {
  if (await read($, layout) === 'pane') {
    await saveLayout($, 'band')
    await $.ui.close({ id: PANE }).catch(() => undefined)
    return
  }
  await saveLayout($, 'pane')
  await $.ui.open({ id: PANE, title: await paneTitle($) }).catch(() => undefined)
}

// ── Drawing ─────────────────────────────────────────────────────────────────

/** Nothing to show: a tree of empty Boxes and blank Text, which is what a band with nothing to say draws. */
function isBlank(node: RenderNode): boolean {
  if (typeof node === 'string') return node.trim() === ''
  if (node.type !== 'Box' && node.type !== 'Text') return false
  return (node.children ?? []).every(isBlank)
}

/**
 * Rows a tree takes, roughly: a column adds its children up, a row takes its
 * tallest, a Text its lines; borders, paddings and margins add theirs. Used to
 * leave the bands below ours the room they already took.
 */
function rowsOf(node: RenderNode): number {
  if (typeof node === 'string') return node.split('\n').length
  const props = ('props' in node ? node.props : undefined) as Record<string, unknown> | undefined
  const children = 'children' in node && Array.isArray(node.children) ? node.children as RenderNode[] : []
  if (node.type === 'Text') return children.filter(c => typeof c === 'string').join('').split('\n').length
  if (node.type !== 'Box') return 1
  const own = children.map(rowsOf)
  const body = props?.flexDirection === 'column' ? own.reduce((a, b) => a + b, 0) : Math.max(0, ...own)
  const n = (k: string) => (typeof props?.[k] === 'number' ? props[k] as number : 0)
  const edges = (k: string) => (n(`${k}Top`) || n(`${k}Y`) || n(k)) + (n(`${k}Bottom`) || n(`${k}Y`) || n(k))
  return body + edges('padding') + edges('margin') + (props?.borderStyle ? 2 : 0)
}



/** A row carries more than its line shows: a message, fields, tags. */
function hasDetail(row: Row): boolean {
  return Boolean(row.message) || row.fields.length > 0 || row.tags.length > 0
}

async function draw(
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0],
  opts: { isPane: boolean; maxRows: number; columns: number },
): Promise<RenderNode | null> {
  if (!config) return null
  const { Box, Text, Button } = $.ui.resolve(e)

  // Claude Desktop draws every Button as a native one, in its own font, where
  // a bare glyph reads as nothing: the brackets and the glyph-only labels are
  // the terminal's alone. Two widths matter, not one: the header's labels give
  // way first, the rows' later, since a row carries more of them.
  const isTerminal = e.surface === 'terminal'
  const narrow = isTerminal && opts.columns < (opts.isPane ? NARROW_PANE : NARROW)
  const tight = isTerminal && opts.columns < (opts.isPane ? TIGHT_PANE : TIGHT)
  const glyph = (g: string) => (isTerminal ? `[${g}]` : g)
  const chip = narrow ? true : undefined

  const where = await read($, scope)
  // The window held is account-wide, shared with the other sessions: the scope
  // is a filter here, like the levels, not a query over there.
  const all = inScope(await read($, events), where)
  const shown = await read($, levels)
  const onlyUnread = await read($, unreadOnly)
  const rows = group(visible(all, shown, onlyUnread))
  const at = await read($, now)
  const problem = await read($, error)
  const paused = await read($, pausedUntil)
  const projectList = await read($, projects)
  const workspaceList = await read($, workspaces)
  const picking = await read($, isPickingScope)
  const open = await read($, selected)

  // The orange frame, the band's look, in the pane too (inside the engine's).
  const frame = { borderStyle: 'round' as const, borderColor: brand, paddingX: 1 }

  const state = (
    <Box gap={1} flexShrink={0}>
      <Text color={brand} bold>⩄ Alarum</Text>
      {problem ? <Text color="error">{problem}</Text> : null}
      {!problem && paused > at ? <Text color="warning">{narrow ? '⏸' : `⏸ paused ${Math.ceil((paused - at) / 1000)}s`}</Text> : null}
    </Box>
  )

  // What a row says about itself besides its title, and never wraps.
  const factsOf = (row: Row) => [
    row.repeats > 1 ? `×${row.repeats}` : '',
    where.kind !== 'project' && row.projectName ? row.projectName : '',
    row.source ? row.source : '',
    ago(row.receivedAt, at),
  ].filter(Boolean).join(' · ')

  // ── The band: one line, always ────────────────────────────────────────────
  // It sits above the prompt, where every other plugin also wants room, so it
  // takes one row and keeps it: the title, the latest event the filters leave,
  // the counters, and the way into the pane, where the work happens.
  if (!opts.isPane) {
    const latest = rows[0] ?? null
    const counters: RenderNode[] = []
    for (const l of [...LEVELS].reverse()) {
      const n = all.filter(x => x.level === l).length
      if (!n) continue
      if (counters.length) counters.push(<Text dimColor> · </Text>)
      counters.push(<Text color={COLOR[l]}>{n} {GLYPH[l]}</Text>)
    }
    return (
      <Box {...frame} flexDirection="column">
        <Box justifyContent="space-between" gap={1}>
          <Box gap={1} flexShrink={1} overflow="hidden">
            {state}
            {latest ? (
              <Box gap={1} flexShrink={1} overflow="hidden">
                <Box flexShrink={0}><Text color={COLOR[latest.level]} bold={BOLD[latest.level]}>{GLYPH[latest.level]}</Text></Box>
                <Text dimColor={latest.read} wrap="truncate-end">{latest.title}</Text>
                <Box flexShrink={0}><Text dimColor>{factsOf(latest)}</Text></Box>
              </Box>
            ) : <Text dimColor>{problem ? '' : 'nothing yet'}</Text>}
          </Box>
          <Box gap={1} flexShrink={0}>
            {counters.length ? <Box gap={0} flexShrink={0}>{counters}</Box> : null}
            <Button key="layout" label={narrow ? glyph('⇥') : '⇥ Pane'} plain={chip} dimColor onPress={() => toggleLayout($)} />
          </Box>
        </Box>
      </Box>
    )
  }

  // ── The pane ──────────────────────────────────────────────────────────────
  // Two header lines, so the title always has its room: six buttons on one
  // line pushed it out of a docked pane, which is how this ended up split.
  const header = (
    <Box flexDirection="column">
      <Box justifyContent="space-between" gap={1}>
        <Box gap={1} flexShrink={1} overflow="hidden">
          {state}
          <Box flexShrink={1} overflow="hidden">
            <Text dimColor wrap="truncate-end">
              {scopeLabel(where, projectList, workspaceList)}{rows.length ? ` · ${rows.length}` : ' · nothing yet'}
            </Text>
          </Box>
        </Box>
        <Box gap={narrow ? 0 : 1} flexShrink={0}>
          <Button key="refresh" label={narrow ? glyph('⟳') : '⟳ Refresh'} plain={chip} dimColor onPress={() => refresh($, { force: true })} />
          <Button key="layout" label={narrow ? glyph('⇤') : '⇤ Band'} plain={chip} dimColor onPress={() => toggleLayout($)} />
        </Box>
      </Box>
      <Box justifyContent="space-between" gap={1}>
        {/* One chip per level, as the web inbox filters them: its own glyph in
            its own colour, lit when the level is on and dim when it is not.
            Glyphs rather than names, so five chips cost five cells. */}
        <Box gap={narrow ? 0 : 1} flexShrink={0}>
          {LEVELS.map(l => {
            const on = shown.includes(l)
            return (
              <Button
                key={`level:${l}`}
                label={glyph(GLYPH[l])}
                plain
                dimColor={!on}
                onPress={() => toggleLevel($, l)}
              >
                <Text color={on ? COLOR[l] : undefined} bold={on && BOLD[l]} dimColor={!on}>{glyph(GLYPH[l])}</Text>
              </Button>
            )
          })}
        </Box>
        {/* An active filter is drawn as the surface marks a control that is on. */}
        <Box gap={narrow ? 0 : 1} flexShrink={0}>
          <Button
            key="scope"
            label={narrow ? glyph('⊙') : '⊙ Scope'}
            plain={where.kind === 'all' ? chip : undefined}
            variant={where.kind === 'all' ? undefined : 'primary'}
            dimColor={where.kind === 'all'}
            onPress={() => update($, isPickingScope, v => !v)}
          />
          <Button
            key="unread"
            label={narrow ? glyph(onlyUnread ? '●' : '○') : (onlyUnread ? '● unread' : '○ all')}
            plain={onlyUnread ? undefined : chip}
            variant={onlyUnread ? 'primary' : undefined}
            dimColor={!onlyUnread}
            onPress={() => toggleUnread($)}
          />
          <Button key="allread" label={narrow ? glyph('✓') : '✓ Mark all'} plain={chip} dimColor onPress={() => markAllRead($)} />
        </Box>
      </Box>
    </Box>
  )

  // A dim rule sets the controls apart from what they act on, after a blank
  // line: the rule hard against the buttons reads as their underline.
  const rule = (
    <Box marginTop={1}>
      <Text dimColor wrap="truncate-end">{'─'.repeat(Math.max(10, opts.columns - 4))}</Text>
    </Box>
  )
  // ── The scope picker takes the list's place while it is open ──────────────
  if (picking) {
    const choices: RenderNode[] = [
      <Button key="scope:all" label="⊙ All projects" plain={where.kind === 'all' ? undefined : true} variant={where.kind === 'all' ? 'primary' : undefined} dimColor={where.kind !== 'all'} onPress={() => setScope($, { kind: 'all' })} />,
    ]
    for (const w of workspaceList) {
      const here = where.kind === 'workspace' && where.id === w.id
      choices.push(
        <Button key={`scope:w:${w.id}`} plain={here ? undefined : true} variant={here ? 'primary' : undefined} dimColor={!here} onPress={() => setScope($, { kind: 'workspace', id: w.id })}>
          {w.name}{w.unreadCount ? ` · ${w.unreadCount}` : ''}
        </Button>,
      )
      for (const p of projectList.filter(x => x.workspaceId === w.id)) {
        const mine = where.kind === 'project' && where.id === p.id
        choices.push(
          <Button key={`scope:p:${p.id}`} plain={mine ? undefined : true} variant={mine ? 'primary' : undefined} dimColor={!mine} onPress={() => setScope($, { kind: 'project', id: p.id })}>
            {`  ${p.name}`}{p.unreadCount ? ` · ${p.unreadCount}` : ''}
          </Button>,
        )
      }
    }
    // Every project, drawn whole. The pane's body is a window over the tree and
    // the engine scrolls it (the wheel, the arrows while it holds the keys), so
    // cutting the list here only made the last projects unreachable.
    return (
      <Box {...frame} flexDirection="column">
        {header}
        {rule}
        {choices}
      </Box>
    )
  }

  /**
   * What an event carries beyond its line, laid out as the web inbox lays it
   * out: when it landed, its message, then its fields as a grid of dim labels
   * over their values, its tags, its link. Two columns where there is room for
   * them, one where there is not.
   */
  const indent = isTerminal ? 4 : 2
  const inner = Math.max(20, opts.columns - indent - 4)
  const columns = inner >= 64 ? 2 : 1
  const cellWidth = Math.floor(inner / columns)
  const stamp = (unix: number) => {
    // UTC, and said so: a terminal has no business guessing a timezone, and a
    // wrong one on an incident timestamp is worse than an explicit offset.
    try { return `${new Date(unix * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC` } catch { return '' }
  }

  const detailOf = (row: Row) => {
    const fields = row.fields.slice(0, 12)
    const grid: Row['fields'][] = []
    for (let i = 0; i < fields.length; i += columns) grid.push(fields.slice(i, i + columns))
    return (
      <Box key={`detail:${row.id}`} flexDirection="column" marginLeft={indent} marginTop={1}>
        <Text dimColor>{stamp(row.receivedAt)}</Text>
        {row.message ? <Box marginTop={1}><Text wrap="wrap">{row.message.slice(0, 800)}</Text></Box> : null}
        {grid.length ? (
          <Box flexDirection="column" marginTop={1}>
            {grid.map((pair, i) => (
              // A blank line between pairs: run together, a value and the next
              // label read as one block and the grid stops being a grid.
              <Box key={`${row.id}:grid:${i}`} flexDirection="column" marginBottom={i < grid.length - 1 ? 1 : 0}>
                <Box gap={2}>
                  {pair.map(f => (
                    <Box key={`${row.id}:l:${f.name}`} width={cellWidth}>
                      <Text dimColor wrap="truncate-end">{f.name.toUpperCase()}</Text>
                    </Box>
                  ))}
                </Box>
                <Box gap={2}>
                  {pair.map(f => (
                    <Box key={`${row.id}:v:${f.name}`} width={cellWidth}>
                      <Text wrap="truncate-end">{f.value}</Text>
                    </Box>
                  ))}
                </Box>
              </Box>
            ))}
          </Box>
        ) : null}
        {row.tags.length ? (
          <Box marginTop={1}><Text dimColor>{row.tags.map(t => ` ${t} `).join(' ')}</Text></Box>
        ) : null}
        {row.url ? <Text dimColor wrap="truncate-end">{row.url}</Text> : null}
      </Box>
    )
  }

  /**
   * One event, over two lines: what it is on top (opener, level, title), what
   * it says about itself underneath. The title IS the link to its page on
   * Alarum, as a ticket's id is in the Floatee mod, which saves a button.
   */
  const rowOf = (row: Row) => {
    const isOpen = open === row.id
    const title = <Text dimColor={row.read} wrap="truncate-end">{row.title}</Text>
    return (
      <Box key={`row:${row.id}`} flexDirection="column">
        <Box justifyContent="space-between" gap={2}>
          <Box gap={1} flexShrink={1} overflow="hidden">
            {/* The opener is the row's leftmost thing, and its slot stays there
                (blank) for an event with nothing more, so the titles line up. */}
            {hasDetail(row)
              ? <Button key={`more:${row.id}`} label={glyph(isOpen ? '▴' : '▾')} plain dimColor onPress={() => update($, selected, v => (v === row.id ? null : row.id))} />
              : <Text>{isTerminal ? '   ' : ' '}</Text>}
            <Box flexShrink={0}><Text color={COLOR[row.level]} bold={BOLD[row.level]}>{GLYPH[row.level]}</Text></Box>
            {row.webUrl
              ? <Button key={`title:${row.id}`} label={row.title} plain onPress={() => openPage($, row.webUrl ?? '')}>{title}</Button>
              : title}
          </Box>
          {/* All three keep their chrome and a space between them at any width.
              Drawn bare with brackets of our own and no gap, as they were, a
              narrow pane ran them into one another and into the real buttons. */}
          <Box gap={1} flexShrink={0}>
            {row.url ? <Button key={`link:${row.id}`} label={tight ? '⇗' : '⇗ Link'} dimColor onPress={() => openPage($, row.url ?? '')} /> : null}
            {/* Ask never shrinks: it is the one action worth naming, and a bare
                glyph says nothing about what it does. */}
            <Button key={`go:${row.id}`} label="⤴ Ask" variant="primary" onPress={() => investigate($, row)} />
            {/* A checkbox, and nothing else: empty while the event is unread,
                ticked once it is, dim once there is nothing left to do with it.
                The label cannot change under the pointer (a hover restyles an
                element or reveals a hidden one, it never swaps one for
                another), so the state lives in the box itself. */}
            <Button key={`read:${row.id}`} label={row.read ? '✓' : ' '} dimColor={row.read} onPress={() => markRead($, row.id, !row.read)} />
          </Box>
        </Box>
        {/* The message's first line, under the title: for a deploy or a CI run
            it is what actually says what happened, and reading it should not
            cost an expand. Its own line, so the facts keep theirs. */}
        {row.message ? (
          <Box marginLeft={isTerminal ? 4 : 2}>
            <Text dimColor={row.read} wrap="truncate-end">{firstLine(row.message)}</Text>
          </Box>
        ) : null}
        <Box marginLeft={isTerminal ? 4 : 2}>
          <Text dimColor wrap="truncate-end">{factsOf(row)}</Text>
        </Box>
        {isOpen && hasDetail(row) ? detailOf(row) : null}
      </Box>
    )
  }

  // The whole window, for the same reason as the picker: the pane scrolls, and
  // an event cut off here is an event nothing can reach. The list is bounded
  // by what was asked for (WINDOW), not by the rows on screen.
  return (
    <Box {...frame} flexDirection="column">
      {header}
      {rule}
      {rows.length === 0 && !problem ? <Text dimColor>Nothing yet. Events land here as they arrive.</Text> : null}
      {/* The pane has room: a blank line between events, for the eye. */}
      <Box flexDirection="column" gap={1}>
        {rows.map(rowOf)}
      </Box>
    </Box>
  )
}
// ── Wiring ──────────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    config = await findConfig($)
    if (!config) return next(e)
    fingerprint = fingerprintOf(config)
    const poll = config.poll
    const fromFile = config.scope

    // A reload happens between turns: no turn is running.
    await update($, isBusy, () => false)
    await update($, isPickingScope, () => false)
    await readBrand($)

    await loadScopes($)
    const stored = await recall($, 'scope')
    const opening = openingScope(stored, fromFile, await read($, projects), await read($, workspaces))
    await update($, scope, () => opening)

    // The filters, as this repo last left them. A stored list that no longer
    // names a level (a renamed one, a hand-edited store) falls back to all of
    // them rather than to an empty band.
    const savedLevels = await recall($, 'levels')
    const kept = Array.isArray(savedLevels) ? LEVELS.filter(l => savedLevels.includes(l)) : []
    await update($, levels, () => (kept.length ? kept : LEVELS))
    const savedUnread = await recall($, 'unread')
    await update($, unreadOnly, () => savedUnread === true)

    const savedLayout = await recall($, 'layout')
    await update($, layout, () => (savedLayout === 'pane' ? 'pane' : 'band'))
    if (savedLayout === 'pane') void $.ui.open({ id: PANE, title: 'Alarum' }).catch(() => undefined)

    await refresh($)

    // One dispatch per tick, the read itself paced by the config: twice as
    // often while Claude is idle, since that is when someone is watching.
    $.clock.every(TICK_MS, async () => {
      const at = await $.clock.now().catch(() => lastRefresh)
      await update($, now, () => at)
      const every = ((await read($, isBusy)) ? poll : poll / 2) * 1000
      if (at - lastRefresh >= every - 500) await refresh($)
    })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (config) await update($, isBusy, () => true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // A subagent's turn ends inside the main one: nothing to do.
    if (!config || (e as { agentId?: string }).agentId) return next(e)
    await update($, isBusy, () => false)
    await refresh($).catch(() => undefined)
    return next(e)
  })

  // The guards, on every tool call, the subagents' included.
  on('tool.call', async ($, e, next) => {
    const no = refusal(e as never)
    if (no) return { deny: `alarum: ${no}` }

    const ran = await next(e)
    if (ran.deny !== undefined) return ran

    // A token in the output is masked. Our own answer (no `ref`), so core maps
    // the masked record instead of reusing its messages.
    TOKEN_RE.lastIndex = 0
    if (!TOKEN_RE.test((ran.text ?? '') + JSON.stringify(ran.result ?? ''))) return ran
    if (ran.isError) return { isError: true, result: mask(ran.result), text: mask(ran.text ?? '') as string }
    return { result: mask(ran.result) as typeof ran.result, ...(ran.context ? { context: ran.context } : {}) }
  }).catch(($, e, next) => {
    // The hook failed, or is being asked again from under its own call. A hook
    // that guards is skipped on a throw unless its handler answers for it, so
    // it judges once more from the event alone (refusal() is pure and needs
    // nothing else). Only `.alarum` is refused here: a bug in this mod must
    // not hand the token over, and must not brick a session either.
    if (next.called) return next(e)
    try {
      const no = refusal(e as never)
      if (no) return { deny: `alarum: ${no}` }
    } catch { /* judged nothing: let it through */ }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!config || e.props.hasSurvey) return next(e)
    // The pane shows the list: the band leaves it the place. A pane still
    // waiting for room leaves the band standing in.
    if (await read($, layout) === 'pane' && (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)) return next(e)

    // What the plugins beneath drew (the Floatee mod, a bleh kit band, the
    // engine's own). Answering without it would make this mod the only band
    // anyone can see, which is not ours to decide: we stack under it instead,
    // and ask for the room it did not take.
    const below = await next(e)
    const others = isBlank(below) ? null : below
    const maxRows = Math.max(0, e.props.maxRows - (others ? rowsOf(others) : 0))
    const tree = await draw($, e, { isPane: false, maxRows, columns: e.props.bodyColumns })
    if (!tree || !others) return tree ?? below
    const { Box } = $.ui.resolve(e)
    return <Box flexDirection="column">{others}{tree}</Box>
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const tree = await draw($, e, { isPane: true, maxRows: e.props.scroll.bodyRows, columns: e.props.bodyColumns })
    const { Text } = $.ui.resolve(e)
    return tree ?? <Text dimColor>No .alarum here: nothing to show.</Text>
  })

  // Closed by hand: back to the band, remembered. Remembering is the whole of
  // it, so a failure here must never keep a pane the person just closed open.
  on('ui.close', async ($, e, next) => {
    if (config && e.id === PANE && e.origin.kind === 'person') await saveLayout($, 'band')
    return next(e)
  }).catch(($, e, next) => next(e))
}
