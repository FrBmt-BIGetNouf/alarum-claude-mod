// The repo's `.alarum`, read by the mod only: the token stays in module
// memory, never in $.state, a log, a prompt or a toast.
import type { Level, Scope } from '../types'

export type Config = {
  token: string
  /** The agent API's base, without a trailing slash. */
  api: string
  /** The web app, where an event's page lives (`web=`; else derived from `api`). */
  web: string
  /** Where the band looks when nothing has been chosen in it yet. */
  scope: Scope
  /**
   * `levels=` pins which levels toast, for every project. Empty (the default)
   * means each project's own notification rules decide, which is what the
   * account already configured in the app.
   */
  levels: Level[]
  /** Seconds between two reads while a turn runs; half that while Claude is idle. */
  poll: number
}

const LEVELS: Level[] = ['info', 'success', 'warn', 'error', 'critical']

const seconds = (v: string | undefined, fallback: number) => {
  const n = Number(v)
  // A one-second poll would spend the token's whole per-minute allowance, and
  // an hour-long one is not a live band any more.
  return Number.isFinite(n) && n >= 10 && n <= 600 ? Math.round(n) : fallback
}

/** `key=value` lines, `#` comments: the same shape as `.floatee`. */
export function parseConfig(text: string): Config | null {
  const kv: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue
    const m = line.match(/^\s*([a-z_]+)\s*=\s*(.*?)\s*$/i)
    if (m && m[1]) kv[m[1].toLowerCase()] = m[2] ?? ''
  }
  if (!kv.token) return null

  const api = (kv.api || 'https://alarum.me/api/v1').replace(/\/+$/, '')
  const scope: Scope = kv.project ? { kind: 'project', id: kv.project }
    : kv.workspace ? { kind: 'workspace', id: kv.workspace }
      : { kind: 'all' }

  return {
    token: kv.token,
    api,
    web: (kv.web || api.replace(/\/api\/v1$/, '')).replace(/\/+$/, ''),
    scope,
    levels: (kv.levels ?? '').split(',').map(s => s.trim().toLowerCase()).filter((s): s is Level => (LEVELS as string[]).includes(s)),
    poll: seconds(kv.poll, 30),
  }
}
