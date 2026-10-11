// The text ⤴ Investigate puts in the prompt box. Pure, so what the agent is
// handed can be asserted without an engine.
import type { AlarumEvent } from '../types'

const MAX_MESSAGE = 1500
const MAX_FIELDS = 10
const MAX_VALUE = 200

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * An event as a question to work on, not as a dump. The order is what someone
 * reading it needs first: what broke, where it came from, then the detail.
 *
 * It is written into the prompt box and NOT sent: the person adds what they
 * know (what they were doing, which branch) before handing it over, which is
 * usually worth more than anything the event carries.
 */
export function investigatePrompt(e: AlarumEvent): string {
  const lines = [
    `Investigate this Alarum event (${e.level}), from the project "${e.projectName}":`,
    '',
    `Title: ${e.title}`,
  ]
  if (e.source) lines.push(`Source: ${e.source}`)
  if (e.tags.length) lines.push(`Tags: ${e.tags.join(', ')}`)
  for (const f of e.fields.slice(0, MAX_FIELDS)) {
    lines.push(`${f.name}: ${clip(f.value.replace(/\s+/g, ' ').trim(), MAX_VALUE)}`)
  }
  if (e.url) lines.push(`Link: ${e.url}`)
  if (e.webUrl) lines.push(`Event: ${e.webUrl}`)
  if (e.message) {
    lines.push('', 'Message:', clip(e.message.trim(), MAX_MESSAGE))
  }
  lines.push('', 'Find what caused it in this repository, and tell me before changing anything.')
  return lines.join('\n')
}
