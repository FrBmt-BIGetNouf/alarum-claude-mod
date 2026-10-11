import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOKEN = `alrm_at_${'A'.repeat(43)}`

const BAND = { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 140, scroll: { offset: 0, bodyRows: 12 }, view: {} }
const PANE = { title: 'Alarum', isFocused: false, bodyColumns: 140, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 24 } }

const PROJECTS = [
  {
    id: 'p1', workspaceId: 'w1', workspaceName: 'Pro', name: 'Alarum', slug: 'alarum',
    unreadCount: 2, lastEventAt: 300,
    push: { info: false, success: false, warn: true, error: true, critical: true },
  },
  {
    id: 'p2', workspaceId: 'w1', workspaceName: 'Pro', name: 'Floatee', slug: 'floatee',
    unreadCount: 0, lastEventAt: 200,
    push: { info: false, success: false, warn: false, error: false, critical: false },
  },
]

const WORKSPACES = [{ id: 'w1', name: 'Pro', unreadCount: 2 }]

const event = (over: Record<string, unknown> = {}) => ({
  id: 'e1', level: 'error', title: 'Deploy failed', message: 'nope', source: 'github-actions',
  tags: [], fields: [], receivedAt: 300, read: false, url: null,
  webUrl: 'https://alarum.me/hooks/e1',
  project: { id: 'p1', name: 'Alarum', workspaceId: 'w1' },
  ...over,
})

/**
 * A repo with an `.alarum`, the API answering `rows()`. Returns what the mod
 * asked of the host: the writes it sent, the toasts it raised, what it put in
 * the prompt box, the URLs it opened.
 */
function repo(on: On, rows: () => unknown[], file = `token=${TOKEN}\napi=https://alarum.test/api/v1\n`, below?: string) {
  // What the plugins beneath draw: empty by default, as the engine's own band
  // is, or `below` when the test wants another band in the way.
  on('ui.render', ($t, e) => {
    const { Box, Text } = $t.ui.resolve(e)
    return below ? <Box><Text>{below}</Text></Box> : <Box />
  })
  const writes: string[] = []
  const reads: string[] = []
  const toasts: string[] = []
  const filled: string[] = []
  const opened: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo/sub' }))
  on('fs.exists', (_$, e) => ({ value: e.path === '/repo/.alarum' }))
  on('fs.read', () => ({ value: file }))
  on('http.fetch', (_$, e) => {
    // Every call carries the token, and nothing else does.
    expect(e.init?.headers?.Authorization).toBe(`Bearer ${TOKEN}`)
    const path = e.url.replace('https://alarum.test/api/v1', '')
    if (e.init?.method && e.init.method !== 'GET') {
      writes.push(`${e.init.method} ${path.replace(/\?.*/, '')} ${e.init.body ?? ''}`.trim())
      return { value: { status: 204, ok: true, headers: {}, text: '' } }
    }
    reads.push(path)
    const body = path.startsWith('/projects') ? { projects: PROJECTS }
      : path.startsWith('/workspaces') ? { workspaces: WORKSPACES }
        : { events: rows(), nextCursor: null, hasMore: false }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  on('ui.toast', (_$, e) => { toasts.push(e.text); return { value: undefined } })
  // What the mod remembers, with the keys it remembers it under.
  const stored: Record<string, unknown> = {}
  on('store.set', (_$, e) => { stored[e.key] = e.value; return { value: undefined } })
  on('store.get', (_$, e) => ({ value: stored[e.key] }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', (_$, e) => { filled.push(e.text); return { isFilled: true } })
  on('env.get', (_$, e) => ({ value: e.name === 'WSL_DISTRO_NAME' ? 'Ubuntu' : undefined }))
  on('process.run', (_$, e) => {
    opened.push(e.argv.join(' '))
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  return { writes, reads, toasts, filled, opened, stored }
}

const text = async (ui: { findAll: (q: object) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({})).map(el => el.text).join('\n')

// ── The band ────────────────────────────────────────────────────────────────

test('the band is one line: the latest event, the counters, the way to the pane', async ($, on) => {
  repo(on, () => [
    event({ id: 'a', title: 'Deploy failed', receivedAt: 300 }),
    event({ id: 'b', title: 'Deploy failed', receivedAt: 290 }),
    event({ id: 'c', level: 'info', title: 'Backup done', receivedAt: 200, read: true }),
  ])
  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'alarum', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const drawn = await text(ui)
  expect(drawn).toContain('⩄ Alarum')
  expect(drawn).toContain('2 ✖')
  expect(drawn).toContain('1 ℹ')
  // The latest the filters keep, with its burst count. The rest is the pane's.
  expect(drawn).toContain('Deploy failed')
  expect(drawn).toContain('×2')
  expect(drawn).not.toContain('Backup done')
  expect(drawn).not.toContain(TOKEN)

  // Nothing to open or act on here: the pane does that.
  expect(await ui.find({ key: 'fold' })).toBeUndefined()
  expect(await ui.find({ key: 'go:a' })).toBeUndefined()
  expect(await ui.find({ key: 'allread' })).toBeUndefined()
  expect(await ui.find({ key: 'layout' })).toBeDefined()
})

test('an empty band still says so, in one line', async ($, on) => {
  repo(on, () => [])
  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'alarum', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await text(ui)).toContain('nothing yet')
})

test('another plugin band keeps its place: ours stacks under it', async ($, on) => {
  repo(on, () => [event({ title: 'Deploy failed' })], undefined, '⨳ Floatee · 3 open')
  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'alarum', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const drawn = await text(ui)
  expect(drawn).toContain('⨳ Floatee · 3 open')
  expect(drawn).toContain('⩄ Alarum')
  expect(drawn).toContain('Deploy failed')
})

test('a repo with no .alarum draws nothing and asks the API nothing', async ($, on) => {
  const calls: string[] = []
  on('ui.render', ($t, e) => { const { Box } = $t.ui.resolve(e); return <Box /> })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/elsewhere' }))
  on('fs.exists', () => ({ value: false }))
  on('http.fetch', (_$, e) => { calls.push(e.url); return { value: { status: 200, ok: true, headers: {}, text: '{}' } } })

  await $.session.start({ cwd: '/elsewhere', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'alarum', surface: 'terminal', component: 'AbovePrompt', props: BAND })

  expect(calls).toEqual([])
  expect((await text(ui)).trim()).toBe('')
})

test('a token the API refuses is said in the band, not swallowed', async ($, on) => {
  on('ui.render', ($t, e) => { const { Box } = $t.ui.resolve(e); return <Box /> })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_$, e) => ({ value: e.path === '/repo/.alarum' }))
  on('fs.read', () => ({ value: `token=${TOKEN}\napi=https://alarum.test/api/v1\n` }))
  on('http.fetch', () => ({ value: { status: 401, ok: false, headers: {}, text: '{"error":"unauthorized"}' } }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'alarum', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await text(ui)).toContain('token refused')
})

test('a plan without the agent API is said once, and only once', async ($, on) => {
  const toasts: string[] = []
  on('ui.render', ($t, e) => { const { Box } = $t.ui.resolve(e); return <Box /> })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_$, e) => ({ value: e.path === '/repo/.alarum' }))
  on('fs.read', () => ({ value: `token=${TOKEN}\napi=https://alarum.test/api/v1\n` }))
  on('http.fetch', () => ({ value: { status: 403, ok: false, headers: {}, text: '{"code":"plan_required"}' } }))
  on('ui.toast', (_$, e) => { toasts.push(e.text); return { value: undefined } })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'alarum', surface: 'terminal', component: 'Pane', requestId: 'alarum', props: PANE })
  await ui.press({ key: 'refresh' })

  expect(toasts.filter(t => t.includes('paid plans'))).toHaveLength(1)
  expect(await text(ui)).toContain('paid plan')
})

test('a 429 pauses the band for as long as the API asked', async ($, on) => {
  on('ui.render', ($t, e) => { const { Box } = $t.ui.resolve(e); return <Box /> })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_$, e) => ({ value: e.path === '/repo/.alarum' }))
  on('fs.read', () => ({ value: `token=${TOKEN}\napi=https://alarum.test/api/v1\n` }))
  let calls = 0
  on('http.fetch', () => {
    calls++
    return { value: { status: 429, ok: false, headers: { 'retry-after': '45' }, text: '{"code":"rate_limited"}' } }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'alarum', surface: 'terminal', component: 'Pane', requestId: 'alarum', props: PANE })
  const before = calls
  // The pause holds: pressing refresh again asks nothing until it elapses.
  await ui.press({ key: 'refresh' })
  expect(calls).toBe(before)
  expect(await text(ui)).toContain('paused')
})

// ── The pane ────────────────────────────────────────────────────────────────

test('the pane keeps its title, whatever its width', async ($, on) => {
  repo(on, () => [event({ id: 'e1' })])
  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })

  // A docked pane is narrow: this is where six buttons on one line pushed the
  // title out of sight.
  const ui = await $.ui.mount({
    plugin: 'alarum', surface: 'terminal', component: 'Pane', requestId: 'alarum',
    props: { ...PANE, bodyColumns: 64 },
  })
  const drawn = await text(ui)
  expect(drawn).toContain('⩄ Alarum')
  expect(drawn).toContain('Deploy failed')
  expect(drawn).toContain('─') // the rule between the controls and the list
  expect(await ui.find({ key: 'allread' })).toBeDefined()
  // The pane is already the pane: no fold toggle there.
  expect(await ui.find({ key: 'fold' })).toBeUndefined()
})

test('a row reads over two lines: what it is, then what it says', async ($, on) => {
  repo(on, () => [event({ id: 'e1', source: 'github-actions' })])
  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'alarum', surface: 'terminal', component: 'Pane', requestId: 'alarum', props: PANE })
  const drawn = await text(ui)
  expect(drawn).toContain('Deploy failed')
  expect(drawn).toContain('github-actions')
  expect(drawn).toContain('Alarum · github-actions')
})

test('the title is the way to the event page: no button of its own', async ($, on) => {
  const { opened } = repo(on, () => [event({ id: 'e1' })])
  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'alarum', surface: 'terminal', component: 'Pane', requestId: 'alarum', props: PANE })
  expect(await ui.find({ key: 'web:e1' })).toBeUndefined()

  await ui.press({ key: 'title:e1' })
  expect(opened.join(' ')).toContain('https://alarum.me/hooks/e1')
})

test('each link gets its own button, and only when it is there', async ($, on) => {
  const { opened } = repo(on, () => [
    event({ id: 'e1', url: 'https://github.com/x/y/actions/runs/1' }),
    event({ id: 'e2', title: 'No link of its own', url: null, receivedAt: 200 }),
  ])
  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'alarum', surface: 'terminal', component: 'Pane', requestId: 'alarum', props: PANE })
  expect(await ui.find({ key: 'link:e1' })).toBeDefined()
  expect(await ui.find({ key: 'link:e2' })).toBeUndefined()

  await ui.press({ key: 'link:e1' })
  expect(opened.join(' ')).toContain('https://github.com/x/y/actions/runs/1')
})

test('a row opens on what it carries, and only then', async ($, on) => {
  repo(on, () => [
    event({ id: 'e1', message: 'Step "build" exited with 1\nsee the log for the stack', fields: [{ name: 'Commit', value: '8aa8bc4' }], tags: ['prod'] }),
    event({ id: 'e2', title: 'Nothing more to say', message: null, fields: [], tags: [], receivedAt: 200 }),
  ])
  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'alarum', surface: 'terminal', component: 'Pane', requestId: 'alarum', props: PANE })
  const shut = await text(ui)
  // The message's first line rides on the row; the rest waits to be opened.
  expect(shut).toContain('Step "build" exited with 1')
  expect(shut).not.toContain('see the log for the stack')
  expect(shut).not.toContain('COMMIT')

  // An event with nothing more has no opener at all.
  expect(await ui.find({ key: 'more:e2' })).toBeUndefined()

  await ui.press({ key: 'more:e1' })
  const open = await text(ui)
  expect(open).toContain('see the log for the stack')
  // Fields read as the web inbox lays them out: a dim label over its value.
  expect(open).toContain('COMMIT')
  expect(open).toContain('8aa8bc4')
  expect(open).toContain('prod')
  // And when it landed, in a timezone nobody has to guess.
  expect(open).toContain('UTC')

  await ui.press({ key: 'more:e1' })
  expect(await text(ui)).not.toContain('see the log for the stack')
})

test('the read mark shows the state, toggles both ways, and tells the API', async ($, on) => {
  const { writes } = repo(on, () => [event({ id: 'e1' })])
  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'alarum', surface: 'terminal', component: 'Pane', requestId: 'alarum', props: PANE })
  expect(await text(ui)).toContain('✗') // unread

  await ui.press({ key: 'read:e1' })
  expect(writes[0]).toBe('POST /events/e1/read')
  expect(await text(ui)).toContain('✓')

  await ui.press({ key: 'read:e1' })
  expect(writes[1]).toBe('DELETE /events/e1/read')
  expect(await text(ui)).toContain('✗')
})

test('Mark all marks the scope, in one call', async ($, on) => {
  const { writes } = repo(on, () => [event({ id: 'e1' })])
  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'alarum', surface: 'terminal', component: 'Pane', requestId: 'alarum', props: PANE })
  await ui.press({ key: 'allread' })
  expect(writes[0]).toBe('POST /events/read-all {"scope":"all"}')
})

test('⤴ puts the event in the prompt box and sends nothing', async ($, on) => {
  const { filled } = repo(on, () => [event({ id: 'e1', fields: [{ name: 'Commit', value: '8aa8bc4' }] })])
  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'alarum', surface: 'terminal', component: 'Pane', requestId: 'alarum', props: PANE })
  await ui.press({ key: 'go:e1' })

  expect(filled).toHaveLength(1)
  expect(filled[0]).toContain('Deploy failed')
  expect(filled[0]).toContain('Commit: 8aa8bc4')
  expect(filled[0]).toContain('before changing anything')
})

test('an arriving event is announced, the first window is not', async ($, on) => {
  let rows = [event({ id: 'a', level: 'error', receivedAt: 300 })]
  const { toasts } = repo(on, () => rows)
  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'alarum', surface: 'terminal', component: 'Pane', requestId: 'alarum', props: PANE })
  expect(toasts).toEqual([])

  // Newer than the baseline, and a level this project asks to hear about.
  rows = [event({ id: 'b', level: 'error', title: 'Deploy failed again', receivedAt: 400 }), ...rows]
  await ui.press({ key: 'refresh' })
  expect(toasts.join('\n')).toContain('Deploy failed again')

  // A level the project does not push: drawn, never announced.
  rows = [event({ id: 'c', level: 'success', title: 'Backup done', receivedAt: 500 }), ...rows]
  await ui.press({ key: 'refresh' })
  expect(toasts.join('\n')).not.toContain('Backup done')
  expect(await text(ui)).toContain('Backup done')
})

test('a level chip turns its level off, and the last one cannot go', async ($, on) => {
  const { toasts } = repo(on, () => [
    event({ id: 'e1', level: 'error', title: 'Deploy failed' }),
    event({ id: 'e2', level: 'info', title: 'Backup started', receivedAt: 200 }),
  ])
  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'alarum', surface: 'terminal', component: 'Pane', requestId: 'alarum', props: PANE })
  expect(await text(ui)).toContain('Backup started')

  await ui.press({ key: 'level:info' })
  const filtered = await text(ui)
  expect(filtered).not.toContain('Backup started')
  expect(filtered).toContain('Deploy failed')

  await ui.press({ key: 'level:info' })
  expect(await text(ui)).toContain('Backup started')

  // Every level off would draw an empty pane with nothing to say why.
  for (const l of ['info', 'success', 'warn', 'critical']) await ui.press({ key: `level:${l}` })
  await ui.press({ key: 'level:error' })
  expect(toasts.join('\n')).toContain('at least one level')
  expect(await text(ui)).toContain('Deploy failed')
})

test('the filters are remembered for this repo, not for every repo at once', async ($, on) => {
  const { stored } = repo(on, () => [event({ id: 'e1', level: 'error' })])
  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'alarum', surface: 'terminal', component: 'Pane', requestId: 'alarum', props: PANE })
  await ui.press({ key: 'level:info' })
  await ui.press({ key: 'unread' })
  await ui.press({ key: 'scope' })      // the picker takes the list's place
  await ui.press({ key: 'scope:p:p2' })

  // The `.alarum` sits at /repo, so the preferences hang off that: another
  // session on another repo keeps its own. The only other thing written is the
  // window shared between sessions, which hangs off the account instead.
  const keys = Object.keys(stored)
  expect(keys.every(k => k.startsWith('/repo:') || k.startsWith('shared:'))).toBe(true)
  expect(keys.some(k => k.startsWith('/repo:'))).toBe(true)
  expect(stored['/repo:levels']).toEqual(['success', 'warn', 'error', 'critical'])
  expect(stored['/repo:unread']).toBe(true)
  expect(stored['/repo:scope']).toEqual({ kind: 'project', id: 'p2' })
})

test('a session opens on the filters this repo last had', async ($, on) => {
  const { stored } = repo(on, () => [
    event({ id: 'e1', level: 'error', title: 'Deploy failed' }),
    event({ id: 'e2', level: 'info', title: 'Backup started', receivedAt: 200 }),
  ])
  stored['/repo:levels'] = ['error']
  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'alarum', surface: 'terminal', component: 'Pane', requestId: 'alarum', props: PANE })
  const drawn = await text(ui)
  expect(drawn).toContain('Deploy failed')
  expect(drawn).not.toContain('Backup started')
})

// ── The window shared between sessions (#695) ───────────────────────────────

/** A store already holding what another session read a moment ago. */
function warmStore(now: number, events: unknown[], fingerprintKey: string) {
  return {
    [`shared:${fingerprintKey}:events`]: { at: now, value: events },
    [`shared:${fingerprintKey}:scopes`]: { at: now, value: { projects: PROJECTS, workspaces: WORKSPACES } },
  }
}

/** The key the mod files its shared copies under: FNV-1a over api and token. */
function fingerprintFor(api: string, token: string): string {
  let h = 0x811c9dc5
  const material = `${api}\n${token}`
  for (let i = 0; i < material.length; i++) {
    h ^= material.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

test('a session reads what another one has just read, instead of asking again', async ($, on) => {
  const NOW = 1_700_000_000_000
  on('clock.now', () => ({ value: NOW }))
  const { stored, writes } = repo(on, () => [event({ id: 'fetched', title: 'From the API' })])
  const key = fingerprintFor('https://alarum.test/api/v1', TOKEN)
  Object.assign(stored, warmStore(NOW - 1000, [{
    id: 'cached', level: 'error', title: 'From the shared window', message: null, source: 'cron',
    tags: [], fields: [], receivedAt: 300, read: false, url: null, webUrl: null,
    projectId: 'p1', projectName: 'Alarum', workspaceId: 'w1',
  }], key))

  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'alarum', surface: 'terminal', component: 'Pane', requestId: 'alarum', props: PANE })

  const drawn = await text(ui)
  expect(drawn).toContain('From the shared window')
  expect(drawn).not.toContain('From the API')
  expect(writes).toEqual([]) // and it wrote nothing of its own

  // Refresh means refresh: the shared copy is skipped on purpose.
  await ui.press({ key: 'refresh' })
  expect(await text(ui)).toContain('From the API')
})

test('another account never reads this one window', async ($, on) => {
  const NOW = 1_700_000_000_000
  on('clock.now', () => ({ value: NOW }))
  const { stored } = repo(on, () => [event({ id: 'mine', title: 'My own event' })])
  // A window left by a different token: the key does not match, so it is not ours.
  Object.assign(stored, warmStore(NOW - 1000, [{
    id: 'theirs', level: 'error', title: 'Somebody else events', message: null, source: 'cron',
    tags: [], fields: [], receivedAt: 300, read: false, url: null, webUrl: null,
    projectId: 'p1', projectName: 'Alarum', workspaceId: 'w1',
  }], fingerprintFor('https://alarum.test/api/v1', `alrm_at_${'Z'.repeat(43)}`)))

  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'alarum', surface: 'terminal', component: 'Pane', requestId: 'alarum', props: PANE })

  const drawn = await text(ui)
  expect(drawn).toContain('My own event')
  expect(drawn).not.toContain('Somebody else events')
})

test('a write drops the shared window, so the other sessions read again', async ($, on) => {
  const NOW = 1_700_000_000_000
  on('clock.now', () => ({ value: NOW }))
  const { stored, reads } = repo(on, () => [event({ id: 'e1' })])
  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'alarum', surface: 'terminal', component: 'Pane', requestId: 'alarum', props: PANE })
  const key = fingerprintFor('https://alarum.test/api/v1', TOKEN)
  expect(stored[`shared:${key}:events`]).toBeDefined()
  const before = reads.filter(p => p.startsWith('/projects')).length

  await ui.press({ key: 'read:e1' })
  // The window is dropped: every other session asks the API on its next tick,
  // instead of drawing an event this one has just marked read.
  expect(stored[`shared:${key}:events`]).toBe(null)
  // The scope lists are dropped too, then read back at once: their unread
  // counts just moved, and this session is the one that moved them.
  expect(reads.filter(p => p.startsWith('/projects')).length).toBe(before + 1)
  expect((stored[`shared:${key}:scopes`] as { at: number })?.at).toBe(NOW)
})

test('the scope is a filter over the shared window, not a query of its own', async ($, on) => {
  const urls: string[] = []
  on('ui.render', ($t, e) => { const { Box } = $t.ui.resolve(e); return <Box /> })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_$, e) => ({ value: e.path === '/repo/.alarum' }))
  on('fs.read', () => ({ value: `token=${TOKEN}\napi=https://alarum.test/api/v1\n` }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('http.fetch', (_$, e) => {
    urls.push(e.url)
    const path = e.url.replace('https://alarum.test/api/v1', '')
    const body = path.startsWith('/projects') ? { projects: PROJECTS }
      : path.startsWith('/workspaces') ? { workspaces: WORKSPACES }
        : {
          events: [
            event({ id: 'here', title: 'In this project', project: { id: 'p1', name: 'Alarum', workspaceId: 'w1' } }),
            event({ id: 'elsewhere', title: 'In the other one', receivedAt: 200, project: { id: 'p2', name: 'Floatee', workspaceId: 'w1' } }),
          ],
          nextCursor: null,
          hasMore: false,
        }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'alarum', surface: 'terminal', component: 'Pane', requestId: 'alarum', props: PANE })

  // Never scoped over the wire: that is what lets every session share one read.
  expect(urls.some(u => u.includes('/events') && (u.includes('project=') || u.includes('workspace=')))).toBe(false)

  await ui.press({ key: 'scope' })
  await ui.press({ key: 'scope:p:p2' })
  const scoped = await text(ui)
  expect(scoped).toContain('In the other one')
  expect(scoped).not.toContain('In this project')
  // And narrowing asked the API for nothing: it is a filter over what is here.
  expect(urls.filter(u => u.includes('/events')).length).toBe(1)
})

test('the scope picker lists the workspaces and their projects', async ($, on) => {
  repo(on, () => [event()])
  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'alarum', surface: 'terminal', component: 'Pane', requestId: 'alarum', props: PANE })
  await ui.press({ key: 'scope' })

  const picker = await text(ui)
  expect(picker).toContain('All projects')
  expect(picker).toContain('Pro')
  expect(picker).toContain('Alarum')
  expect(picker).toContain('Floatee')

  await ui.press({ key: 'scope:p:p2' })
  expect(await text(ui)).toContain('Floatee')
})

test('every project is reachable, however short the pane and however many there are', async ($, on) => {
  // Fifty projects in a pane eight rows tall: cutting the list to what fits
  // left the last ones with no way to be picked at all.
  const many = Array.from({ length: 50 }, (_, i) => ({
    id: `p${i}`, workspaceId: 'w1', workspaceName: 'Pro', name: `Project ${i}`, slug: `project-${i}`,
    unreadCount: 0, lastEventAt: null,
    push: { info: false, success: false, warn: true, error: true, critical: true },
  }))
  on('ui.render', ($t, e) => { const { Box } = $t.ui.resolve(e); return <Box /> })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_$, e) => ({ value: e.path === '/repo/.alarum' }))
  on('fs.read', () => ({ value: `token=${TOKEN}\napi=https://alarum.test/api/v1\n` }))
  on('http.fetch', (_$, e) => {
    const path = e.url.replace('https://alarum.test/api/v1', '')
    const body = path.startsWith('/projects') ? { projects: many }
      : path.startsWith('/workspaces') ? { workspaces: WORKSPACES }
        : { events: [], nextCursor: null, hasMore: false }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({
    plugin: 'alarum', surface: 'terminal', component: 'Pane', requestId: 'alarum',
    props: { ...PANE, scroll: { offset: 0, bodyRows: 8 } },
  })
  await ui.press({ key: 'scope' })

  // The pane scrolls its own body: the very last project is drawn, and pressable.
  expect(await ui.find({ key: 'scope:p:p49' })).toBeDefined()
  expect(await text(ui)).not.toContain('more')

  await ui.press({ key: 'scope:p:p49' })
  expect(await text(ui)).toContain('Project 49')
})

test('the project named in .alarum is what the pane opens on', async ($, on) => {
  repo(on, () => [event()], `token=${TOKEN}\napi=https://alarum.test/api/v1\nproject=floatee\n`)
  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'alarum', surface: 'terminal', component: 'Pane', requestId: 'alarum', props: PANE })
  expect(await text(ui)).toContain('Floatee')
})
