# claude-mods

Local Claude Code mods for namcp, kept as a folder marketplace named `ame-mods`. An installed mod is read from this folder itself, so an edit here reaches a session after `/reload-plugins`, with no reinstall.

## Mods

| Mod | What it does |
| --- | --- |
| `cache-handoff` | When an idle main session with 50k context tokens or more has about 5 minutes left on its 1h prompt cache, forks a handoff summary and keeps it in the mod's own `$.store`, local to Claude Code. Once the cache has gone cold, it acts by the `coldAction` option in `/plugin configure`: `new` (default) runs `/clear`, renames the new conversation to the old name plus the date and time, and puts the handoff in front of the first prompt typed there; `notice` pins a reminder under the prompt; `off` does nothing. `/handoff off`, `on` and `now` control it per session. See `mods/cache-handoff/FLOW.md`. |

## Probes

`probes/` holds throwaway mods that check engine behaviour live before a mod relies on it. They are not in the marketplace; run one with `claude --plugin-dir probes/<probe>`. Each writes `probe.log` in its own folder.

## Install

```
claude plugin marketplace add D:\ws\ame\claude-mods
claude plugin install cache-handoff@ame-mods
```

## Develop

```
claude plugin validate mods/<mod>
claude plugin test mods/<mod>
```

Type-check with `tsc -p mods/<mod>`. The engine writes `mods/<mod>/.claude-plugin/types/` once it loads the mod; it is not committed.

## Limits

The mod works only while the session stays open: its timer stops when Claude Code exits. A handoff stored before exit waits for `/handoff now` in the resumed session.

For a quick live test, shorten the timings with `CACHE_HANDOFF_TTL_MIN` and `CACHE_HANDOFF_LEAD_MIN` (minutes) in the environment before starting Claude Code.
