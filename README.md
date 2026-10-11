# Alarum mod for Claude Code

Your [Alarum](https://alarum.me) events where you work: what arrives while a
session runs, without leaving the terminal for the inbox.

**A line above the prompt** holds the latest event your filters leave, with a
count per level, and takes nothing else. **A side pane** does the work:

- every event of the account, newest first, with its level, project, source and age
- **⤴ Ask** drops an event into the prompt box, unsent, so a failed deploy
  becomes the next thing you ask about
- the title opens the event's page in Alarum; **↗ Link** opens whatever the
  sender attached
- **▾** unfolds what the event carries: its message, its fields as a grid, its tags
- **✓ / ✗** marks one read, **✓ Mark all** the whole scope, both reflected in
  the web inbox
- **⊙ Scope** narrows to one workspace or one project; a chip per level and an
  unread filter do the rest, and they are remembered per repository
- a toast on arrival, for the levels your account already asks to be notified
  about for that project
- a burst of identical events folds into one row with a count

Several sessions open at once share one read: whichever finds the window stale
fetches it, the others draw what it left.

## Install

In Claude Code:

```
/plugin marketplace add FrBmt-BIGetNouf/alarum-claude-mod
/plugin install alarum@alarum
```

Claude Code keeps it up to date.

## Requirements

An `.alarum` file at the repo root, holding an **agent token** created under
Settings → Your agent in Alarum. The agent API is part of the paid plans.

```
token=alrm_at_…
api=https://alarum.me/api/v1
```

Optional lines:

| Line | What it does |
| --- | --- |
| `project=<id or slug>` | the scope the pane opens on, the first time |
| `workspace=<id or name>` | same, for a whole workspace |
| `levels=warn,error` | pins which levels toast, instead of following each project's notification rules |
| `poll=30` | seconds between two reads while a turn runs (half that while Claude is idle) |

Add `.alarum` to your `.gitignore`: the token reads every project the account
can reach.

## Safety

- The mod reads `.alarum` itself and refuses to let the agent read it, so the
  token never enters the conversation
- Any Alarum token printed by a command is masked before the model sees it
- Nothing from that file is ever written to the session's state, and the shared
  window is filed under a hash of the token, never the token
- No `.alarum` in the repo means no pane and no request at all

## License

MIT, see [LICENSE](LICENSE).
