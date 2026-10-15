# cache-handoff

A Claude Code mod that saves you from paying to re-cache a long conversation after you step away.

Claude Code keeps your conversation in a prompt cache for about an hour. If you come back after the cache has expired, your next prompt sends the whole transcript again at the full price. cache-handoff writes a short handoff note while the cache is still warm, and once the cache has gone cold it opens a fresh conversation that starts from that note.

## How it works

Times count from the end of your last turn, on the usual 1 hour cache.

| When | What happens |
| --- | --- |
| 0 min | Your turn ends. The mod starts watching, but only if the conversation holds 50k context tokens or more. Smaller ones are cheap to re-cache, so it leaves them alone. |
| 54 min | The mod asks Claude for a handoff note (goal, progress, decisions, files, next step) while the cache is still warm. If the work is finished, Claude says so and nothing is saved. |
| 54 to 114 min | The cache is still warm. Come back now and you simply continue the full conversation; the saved note is discarded. |
| 114 min | The cache is cold. The mod runs `/clear` and renames the new conversation to `<old name>_YYYYMMDD_HHMMSS` if the old one had a name. |
| Later | The first prompt you type there carries the handoff note in front of your text, once. |

Your old conversation is never changed. The carried handoff ends with the command to reopen it in full: `claude --resume <old id>`.

On the 5 minute cache tier there is not enough time to write a handoff, so the mod only shows a reminder to `/clear` once that cache has gone cold.

## Install

```
/plugin marketplace add pnam16/claude-mods
/plugin install cache-handoff@ame-mods
```

This needs a Claude Code build that supports mods (hooks modules loaded from `hooks/hooks.json`).

## Use

The mod runs on its own. The `/handoff` command controls it for the current session:

| Command | Effect |
| --- | --- |
| `/handoff` | Show whether it is armed and whether a handoff is stored. |
| `/handoff off` | Stop watching this session. |
| `/handoff on` | Start watching again from the next turn. |
| `/handoff now` | Open the new conversation from the stored handoff right away, for example after you resumed a session with `claude --resume`. |

## Settings

Set `coldAction` in `/plugin configure`:

| Value | When the cache goes cold |
| --- | --- |
| `new` (default) | Open a new conversation from the handoff, as described above. |
| `notice` | Only show a reminder under the prompt; `/handoff now` still opens the new conversation when you want it. |
| `off` | Do nothing at cold. The handoff is still written at 54 min and kept until your next turn. |

To try the whole cycle in a few minutes, shorten the timings before starting Claude Code:

```powershell
$env:CACHE_HANDOFF_TTL_MIN = 3; $env:CACHE_HANDOFF_LEAD_MIN = 1; claude
```

```bash
CACHE_HANDOFF_TTL_MIN=3 CACHE_HANDOFF_LEAD_MIN=1 claude
```

## Good to know

- Writing the handoff is one extra model call per long idle gap. It reads the warm cache, so it is cheap, and it also keeps the cache warm for another hour.
- Only a prompt you type takes the handoff. Messages from other sessions and plugin prompts pass through unchanged.
- The new conversation does not inherit the old one's todo list, permissions granted during that session, or background tasks.
- The mod works only while Claude Code is open. A handoff saved before you quit is offered again when you resume that session, and is dropped after 7 days if nobody comes back for it.
- The handoff is kept in the mod's own local storage inside Claude Code. Nothing is sent anywhere else.
- The mod reads the session transcript with `tail` and `grep` when they are on PATH, to find the cache tier and the conversation name.

## More detail

[FLOW.md](FLOW.md) has the full decision flow, the API each step uses, and the live test record.
