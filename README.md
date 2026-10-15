# claude-mods

Claude Code mods by ame, published as the plugin marketplace `ame-mods`.

## Mods

| Mod | What it does |
| --- | --- |
| [cache-handoff](mods/cache-handoff/README.md) | Saves you from paying to re-cache a long conversation after you step away. While the prompt cache is still warm it writes a short handoff note, and once the cache has gone cold it opens a fresh conversation that starts from that note. The old conversation stays whole for `claude --resume`. |

## Install

Add the marketplace once, then install any mod from it:

```
/plugin marketplace add pnam16/claude-mods
/plugin install cache-handoff@ame-mods
```

The mods need a Claude Code build that supports mods (hooks modules loaded from `hooks/hooks.json`). Each mod's README covers its commands and settings.

## Develop

Clone the repo and add it as a local marketplace. An installed mod is then read straight from the clone, so an edit reaches a session after `/reload-plugins`, with no reinstall:

```
claude plugin marketplace add <path to your clone>
claude plugin install cache-handoff@ame-mods
```

Check a mod before committing:

```
claude plugin validate mods/<mod>
claude plugin test mods/<mod>
tsc -p mods/<mod>
```

The engine writes `mods/<mod>/.claude-plugin/types/` once it loads the mod; that folder is not committed.
