// What the mod enforces on every tool call, the subagents' included:
//
// G1  the agent never reads `.alarum` (the token would enter the context)
// G2  an Alarum token printed by any tool is masked before the model reads it
//
// Both exist for the same reason: an agent token reads every project its owner
// can reach, so it must never end up in a transcript, a log or a commit.

// alrm_at_ + 43 base64url chars is the agent token; alrm_ + 43 the ingestion
// one. Both are masked: an ingestion token pasted into a curl, or printed by a
// `cat` of a config, is just as much a secret, and the mod is the only thing
// watching tool output here. Shorter look-alikes (doc placeholders, the
// prefix+suffix the app displays) are left alone so files stay readable.
export const TOKEN_RE = /alrm_(?:at_)?[A-Za-z0-9_-]{40,}/g
const MASK = 'alrm_[hidden by the alarum mod]'

// `.alarum` as a path, not as a word inside another name, nor an escaped
// regex (`grep "\.alarum"`).
const DOTFILE_RE = /(^|[^\w.\\-])\.alarum(?![\w.-])/
// Prose that merely names the file (a commit message, a ticket body): heredocs
// and quoted strings holding a space. A path is a single word.
const PROSE_RE = /<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s*\2(?=\s|$)|"[^"\n]*\s[^"]*"|'[^'\n]*\s[^']*'/g
// An existence test is fine: it prints nothing of the file.
const EXISTS_RE = /(test\s+-[efs]|\[\s+-[efs])\s+["']?[^\s;&|"']*\.alarum["']?(\s*\])?/g

/** A copy of a tool's record with every token masked; the same value when none. */
export function mask(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(TOKEN_RE, MASK)
  if (Array.isArray(value)) return value.map(mask)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v)]))
  }
  return value
}

const READ_NOTE = 'The alarum mod keeps `.alarum` out of the conversation: it holds an API token that reads every project of the account. The band reads it itself; nothing in the repo needs its contents.'

/** Why this call must not run, or null. */
export function refusal(e: { tool: string } & Record<string, unknown>): string | null {
  const str = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : '')

  if (['Read', 'Edit', 'NotebookEdit'].includes(e.tool) && /(^|[\\/])\.alarum$/.test(str('file_path') || str('notebook_path'))) return READ_NOTE
  if (e.tool === 'Grep' && /(^|[\\/])\.alarum$/.test(str('path'))) return READ_NOTE
  if (e.tool !== 'Bash') return null

  const command = str('command')
  // A write to the file is the one Bash case we allow: creating or editing it
  // is how a person sets the mod up, and it prints nothing back.
  if (/>\s*["']?[^\s"';|&]*\.alarum\b/.test(command)) return null
  if (DOTFILE_RE.test(command.replace(PROSE_RE, '').replace(EXISTS_RE, ''))) {
    return `${READ_NOTE} To check that it exists: \`test -f .alarum\`.`
  }
  return null
}
