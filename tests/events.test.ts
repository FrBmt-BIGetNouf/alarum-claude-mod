import { expect, test } from 'claude-code/testing'

import type { AlarumEvent, Level, Project } from '../types'
import { ago, announce, counts, group, LEVELS, newestAt, openingScope, resolveScope, toEvent, visible } from '../hooks/events'

const event = (over: Partial<AlarumEvent> = {}): AlarumEvent => ({
  id: 'e1', level: 'info', title: 'A thing happened', message: null, source: 'cron',
  tags: [], fields: [], receivedAt: 1000, read: false, projectId: 'p1', projectName: 'Alarum',
  url: null, webUrl: null, ...over,
})

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1', workspaceId: 'w1', workspaceName: 'Pro', name: 'Alarum', slug: 'alarum', unreadCount: 0,
  push: { info: false, success: true, warn: true, error: true, critical: true }, ...over,
})

test('a burst folds into one row, an event that comes back later does not', () => {
  const rows = group([
    event({ id: 'a', title: 'Deploy failed', level: 'error', receivedAt: 300 }),
    event({ id: 'b', title: 'Deploy failed', level: 'error', receivedAt: 290 }),
    event({ id: 'c', title: 'Deploy failed', level: 'error', receivedAt: 280 }),
    event({ id: 'd', title: 'Backup done', level: 'success', receivedAt: 200 }),
    // The same title again, but not next to its kin: its own row, so the
    // list stays in true chronological order.
    event({ id: 'e', title: 'Deploy failed', level: 'error', receivedAt: 100 }),
  ])
  expect(rows.map(r => [r.id, r.repeats])).toEqual([['a', 3], ['d', 1], ['e', 1]])
})

test('a grouped row is unread as soon as one of its events is', () => {
  const rows = group([
    event({ id: 'a', title: 'Same', read: true }),
    event({ id: 'b', title: 'Same', read: false }),
  ])
  expect(rows).toHaveLength(1)
  expect(rows[0]?.read).toBe(false)
})

test('a different project breaks the grouping', () => {
  const rows = group([
    event({ id: 'a', title: 'Deploy failed', projectId: 'p1' }),
    event({ id: 'b', title: 'Deploy failed', projectId: 'p2' }),
  ])
  expect(rows).toHaveLength(2)
})

test('the counter line counts every level it was given', () => {
  const by = counts([event({ level: 'error' }), event({ level: 'error' }), event({ level: 'info' })])
  expect(by.error).toBe(2)
  expect(by.info).toBe(1)
  expect(by.critical).toBe(0)
})

test('the filters keep the levels that are on, and unread only', () => {
  const list = [
    event({ id: 'i', level: 'info' }),
    event({ id: 'w', level: 'warn' }),
    event({ id: 'e', level: 'error', read: true }),
  ]
  expect(visible(list, LEVELS, false).map(e => e.id)).toEqual(['i', 'w', 'e'])
  expect(visible(list, ['warn', 'error'], false).map(e => e.id)).toEqual(['w', 'e'])
  // Levels pick themselves one by one, not as a threshold: info and error
  // without warn is a thing someone asks for.
  expect(visible(list, ['info', 'error'], false).map(e => e.id)).toEqual(['i', 'e'])
  expect(visible(list, LEVELS, true).map(e => e.id)).toEqual(['i', 'w'])
  expect(visible(list, ['warn', 'error'], true).map(e => e.id)).toEqual(['w'])
  expect(visible(list, [], false)).toEqual([])
})

test('the first load announces nothing: the window is the baseline', () => {
  const list = [event({ level: 'error', receivedAt: 900 })]
  expect(announce(list, 0, [project()], [], LEVELS)).toEqual([])
})

test('what is announced follows each project notify levels', () => {
  const projects = [
    project({ id: 'p1', push: { info: false, success: false, warn: false, error: true, critical: true } }),
    project({ id: 'p2', name: 'Quiet', push: { info: false, success: false, warn: false, error: false, critical: false } }),
  ]
  const list = [
    event({ id: 'new-error', level: 'error', receivedAt: 200, projectId: 'p1' }),
    event({ id: 'new-info', level: 'info', receivedAt: 201, projectId: 'p1' }),
    event({ id: 'muted-project', level: 'error', receivedAt: 202, projectId: 'p2' }),
    event({ id: 'old', level: 'critical', receivedAt: 50, projectId: 'p1' }),
    // A project the listing never carried announces nothing rather than guessing.
    event({ id: 'unknown-project', level: 'critical', receivedAt: 203, projectId: 'p9' }),
  ]
  expect(announce(list, 100, projects, [], LEVELS).map(e => e.id)).toEqual(['new-error'])
})

test('levels= in .alarum overrides every project rule', () => {
  const projects = [project({ push: { info: false, success: false, warn: false, error: false, critical: false } })]
  const list = [event({ id: 'w', level: 'warn', receivedAt: 200 }), event({ id: 'e', level: 'error', receivedAt: 201 })]
  expect(announce(list, 100, projects, ['warn'] as Level[], LEVELS).map(e => e.id)).toEqual(['w'])
})

test('a level filtered out of the view is filtered out of the toasts', () => {
  // Filtering down to errors means "only this", interruptions included.
  const projects = [project({ push: { info: true, success: true, warn: true, error: true, critical: true } })]
  const list = [
    event({ id: 'e', level: 'error', receivedAt: 200 }),
    event({ id: 's', level: 'success', receivedAt: 201 }),
  ]
  expect(announce(list, 100, projects, [], ['error']).map(e => e.id)).toEqual(['e'])
  // A filter can only take announcements away, never add one the project refuses.
  const quiet = [project({ push: { info: false, success: false, warn: false, error: false, critical: false } })]
  expect(announce(list, 100, quiet, [], LEVELS)).toEqual([])
})

test('announcements come out oldest first, as they happened', () => {
  const projects = [project({ push: { info: true, success: true, warn: true, error: true, critical: true } })]
  const list = [event({ id: 'later', receivedAt: 300 }), event({ id: 'sooner', receivedAt: 200 })]
  expect(announce(list, 100, projects, [], LEVELS).map(e => e.id)).toEqual(['sooner', 'later'])
})

test('the baseline is the newest event of the window', () => {
  expect(newestAt([event({ receivedAt: 10 }), event({ receivedAt: 900 }), event({ receivedAt: 3 })])).toBe(900)
  expect(newestAt([])).toBe(0)
})

test('ages read as a glance needs them', () => {
  const nowMs = 1_000_000 * 1000
  expect(ago(1_000_000 - 5, nowMs)).toBe('5s')
  expect(ago(1_000_000 - 120, nowMs)).toBe('2m')
  expect(ago(1_000_000 - 7200, nowMs)).toBe('2h')
  expect(ago(1_000_000 - 172_800, nowMs)).toBe('2d')
  // A clock that drifted backwards must not print a negative age.
  expect(ago(1_000_100, nowMs)).toBe('0s')
})

test('a scope can name a project by slug, as a hand-written .alarum would', () => {
  const projects = [project({ id: 'uuid-1', slug: 'alarum' })]
  const workspaces = [{ id: 'w1', name: 'Pro', unreadCount: 0 }]
  expect(resolveScope({ kind: 'project', id: 'alarum' }, projects, workspaces)).toEqual({ kind: 'project', id: 'uuid-1' })
  expect(resolveScope({ kind: 'project', id: 'uuid-1' }, projects, workspaces)).toEqual({ kind: 'project', id: 'uuid-1' })
  expect(resolveScope({ kind: 'workspace', id: 'pro' }, projects, workspaces)).toEqual({ kind: 'workspace', id: 'w1' })
  expect(resolveScope({ kind: 'project', id: 'gone' }, projects, workspaces)).toBe(null)
})

test('the opening scope: what was chosen here, else the file, else everything', () => {
  const projects = [project({ id: 'p1', slug: 'alarum' }), project({ id: 'p2', slug: 'floatee' })]
  const workspaces = [{ id: 'w1', name: 'Pro', unreadCount: 0 }]
  const fromFile = { kind: 'project', id: 'alarum' } as const

  expect(openingScope({ kind: 'project', id: 'p2' }, fromFile, projects, workspaces)).toEqual({ kind: 'project', id: 'p2' })
  expect(openingScope(null, fromFile, projects, workspaces)).toEqual({ kind: 'project', id: 'p1' })
  // A stored scope that no longer resolves falls back to the file, then to all.
  expect(openingScope({ kind: 'project', id: 'gone' }, fromFile, projects, workspaces)).toEqual({ kind: 'project', id: 'p1' })
  expect(openingScope(null, { kind: 'project', id: 'gone' }, projects, workspaces)).toEqual({ kind: 'all' })
})

test('an unreadable row is dropped, not thrown over', () => {
  expect(toEvent(null)).toBe(null)
  expect(toEvent({ id: 'x', title: 'No level' })).toBe(null)
  expect(toEvent({ id: 'x', title: 'Bad level', level: 'shouty' })).toBe(null)

  const ok = toEvent({
    id: 'x', title: 'Fine', level: 'warn', message: '', receivedAt: 12, read: true,
    tags: ['a', 7], fields: [{ name: 'Commit', value: 'abc' }, { name: 'bad' }],
    project: { id: 'p1', name: 'Alarum' }, webUrl: 'https://alarum.me/hooks/x',
  })
  expect(ok?.tags).toEqual(['a'])
  expect(ok?.fields).toEqual([{ name: 'Commit', value: 'abc' }])
  expect(ok?.message).toBe(null) // an empty message is no message
  expect(ok?.projectName).toBe('Alarum')
})
