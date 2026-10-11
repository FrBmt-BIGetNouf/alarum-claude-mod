import { expect, test } from 'claude-code/testing'

import type { AlarumEvent } from '../types'
import { investigatePrompt } from '../hooks/investigate'

const EVENT: AlarumEvent = {
  id: 'e1',
  level: 'error',
  title: 'Deploy failed — 8aa8bc4',
  message: 'Step "build" exited with 1',
  source: 'github-actions',
  tags: ['deploy', 'prod'],
  fields: [{ name: 'Commit', value: '8aa8bc4' }, { name: 'Branch', value: 'main' }],
  receivedAt: 1000,
  read: false,
  projectId: 'p1',
  projectName: 'Patrons Parlons',
  url: 'https://github.com/x/y/actions/runs/1',
  webUrl: 'https://alarum.me/hooks/e1',
}

test('the prompt leads with what broke and where it came from', () => {
  const text = investigatePrompt(EVENT)
  expect(text).toContain('(error)')
  expect(text).toContain('Patrons Parlons')
  expect(text).toContain('Title: Deploy failed — 8aa8bc4')
  expect(text).toContain('Source: github-actions')
  expect(text).toContain('Tags: deploy, prod')
  expect(text).toContain('Commit: 8aa8bc4')
  expect(text).toContain('Link: https://github.com/x/y/actions/runs/1')
  expect(text).toContain('Event: https://alarum.me/hooks/e1')
  expect(text).toContain('Step "build" exited with 1')
  // It asks for a diagnosis, not for a change: the person has not sent it yet.
  expect(text).toContain('before changing anything')
})

test('an event with nothing but a title still makes a usable prompt', () => {
  const text = investigatePrompt({
    ...EVENT, message: null, source: null, tags: [], fields: [], url: null, webUrl: null,
  })
  expect(text).toContain('Title: Deploy failed — 8aa8bc4')
  expect(text).not.toContain('Source:')
  expect(text).not.toContain('Link:')
  expect(text).not.toContain('Message:')
})

test('a runaway message or field is clipped, so the box stays usable', () => {
  const text = investigatePrompt({
    ...EVENT,
    message: 'x'.repeat(5000),
    fields: Array.from({ length: 30 }, (_, i) => ({ name: `f${i}`, value: 'y'.repeat(400) })),
  })
  expect(text.length).toBeLessThan(4000)
  expect(text).toContain('…')
  expect(text).toContain('f9:')
  expect(text).not.toContain('f12:')
})
