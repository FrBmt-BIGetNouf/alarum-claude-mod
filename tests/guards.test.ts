import { expect, test } from 'claude-code/testing'

import { mask, refusal } from '../hooks/guards'
import { parseConfig } from '../hooks/config'

const AGENT = `alrm_at_${'A'.repeat(43)}`
const INGEST = `alrm_${'B'.repeat(43)}`

test('the agent never reads .alarum, whichever tool it reaches for', () => {
  expect(refusal({ tool: 'Read', file_path: '/repo/.alarum' })).toContain('keeps `.alarum` out')
  expect(refusal({ tool: 'Edit', file_path: '.alarum' })).toBeTruthy()
  expect(refusal({ tool: 'Grep', path: '/repo/.alarum' })).toBeTruthy()
  expect(refusal({ tool: 'Bash', command: 'cat .alarum' })).toBeTruthy()
  expect(refusal({ tool: 'Bash', command: 'head -1 /repo/.alarum | base64' })).toBeTruthy()
})

test('what is not a read of that file goes through', () => {
  expect(refusal({ tool: 'Read', file_path: '/repo/README.md' })).toBe(null)
  // Naming the file in prose (a commit message, a ticket body) is not reading it.
  expect(refusal({ tool: 'Bash', command: 'git commit -m "ignore .alarum in the repo"' })).toBe(null)
  // Checking that it exists prints nothing of it.
  expect(refusal({ tool: 'Bash', command: 'test -f .alarum && echo yes' })).toBe(null)
  // Creating it is how someone sets the mod up.
  expect(refusal({ tool: 'Bash', command: 'printf "token=x\\n" > .alarum' })).toBe(null)
  // A file that merely starts the same way.
  expect(refusal({ tool: 'Read', file_path: '/repo/.alarumrc' })).toBe(null)
})

test('both token families are masked in a tool output, whatever shape it has', () => {
  expect(mask(`sent with ${AGENT} ok`)).toBe('sent with alrm_[hidden by the alarum mod] ok')
  expect(mask(`curl -H "Authorization: Bearer ${INGEST}"`)).toContain('alrm_[hidden by the alarum mod]')
  expect(mask({ a: [{ b: AGENT }] })).toEqual({ a: [{ b: 'alrm_[hidden by the alarum mod]' }] })
  // What the app itself displays (a prefix and a suffix) stays readable.
  expect(mask('alrm_at_N0Ms…M2b0')).toBe('alrm_at_N0Ms…M2b0')
  expect(mask('nothing to hide')).toBe('nothing to hide')
})

test('.alarum is read as key=value, with sensible defaults', () => {
  const c = parseConfig(`# the repo's events\ntoken=${AGENT}\nproject=alarum\n`)
  expect(c?.token).toBe(AGENT)
  expect(c?.api).toBe('https://alarum.me/api/v1')
  expect(c?.web).toBe('https://alarum.me')
  expect(c?.scope).toEqual({ kind: 'project', id: 'alarum' })
  expect(c?.levels).toEqual([])
  expect(c?.poll).toBe(30)
})

test('a file with no token is no config at all', () => {
  expect(parseConfig('project=alarum\n')).toBe(null)
  expect(parseConfig('')).toBe(null)
})

test('the optional lines: api, workspace, levels, poll', () => {
  const c = parseConfig([
    `token=${AGENT}`,
    'api=https://alarum.test/api/v1/',
    'workspace=w1',
    'levels=warn, error, nonsense',
    'poll=120',
  ].join('\n'))
  expect(c?.api).toBe('https://alarum.test/api/v1')
  expect(c?.web).toBe('https://alarum.test')
  expect(c?.scope).toEqual({ kind: 'workspace', id: 'w1' })
  expect(c?.levels).toEqual(['warn', 'error'])
  expect(c?.poll).toBe(120)
})

test('an absurd poll falls back rather than burning the rate limit', () => {
  expect(parseConfig(`token=${AGENT}\npoll=1`)?.poll).toBe(30)
  expect(parseConfig(`token=${AGENT}\npoll=99999`)?.poll).toBe(30)
  expect(parseConfig(`token=${AGENT}\npoll=soon`)?.poll).toBe(30)
})
