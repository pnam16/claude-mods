import type { EngineInterface, Register, Timer } from 'claude-code'

const MINUTE_MS = 60_000
const SHORT_CACHE_TTL_MS = 5 * MINUTE_MS
const POLL_MS = 30_000
// A conversation smaller than this costs little to re-cache, so the mod
// leaves it alone.
const MIN_CONTEXT_TOKENS = 50_000
// Rows read back from the transcript's end when looking for the cache tier.
const TIER_SCAN_ROWS = 400
// Stored handoffs nobody came back for are dropped after this long.
const STORE_MAX_AGE_MS = 7 * 24 * 60 * MINUTE_MS
const STORE_PREFIX = 'handoff:'
const NO_HANDOFF = 'NO_HANDOFF'

const HANDOFF_PROMPT = [
  'This session has been idle and its prompt cache is about to expire.',
  'Write a handoff note so a fresh session can resume this work without the transcript.',
  'Cover: the goal, what is done, decisions made and why, files and paths touched,',
  'open questions, and the exact next step. Plain Markdown, at most 400 words, no preamble.',
  `If the work is finished and nothing is left to resume, reply with exactly ${NO_HANDOFF} and nothing else.`,
].join(' ')

type CacheTier = '1h' | '5m' | 'unknown'
type ColdAction = 'new' | 'notice' | 'off'
type StoredHandoff = { text: string; writtenAt: number; cwd: string }

// The settings: coldAction from /plugin configure, the timings from the
// environment so a live test can shorten them.
const config = {
  coldAction: 'new' as ColdAction,
  cacheTtlMs: 60 * MINUTE_MS,
  leadMs: 6 * MINUTE_MS,
}

// The main loop's idle clock; the module's own, so a reload starts it over.
const idle = {
  lastTurnEndAt: undefined as number | undefined,
  isArmed: false,
  isDisabled: false,
  isInTurn: false,
  isWriting: false,
  transcriptPath: undefined as string | undefined,
  cacheTtlMs: 0,
  // The handoff fork read the cache and so refreshed it: the cache goes cold
  // one TTL after the later of this and the last turn.
  forkedAt: undefined as number | undefined,
  // The fork said the work is finished: nothing to do at cold.
  isFinished: false,
  isColdHandled: false,
  isNoticeShown: false,
  // The handoff the next typed prompt of the new conversation carries, and
  // the store key it came from.
  pendingHandoff: undefined as string | undefined,
  pendingKey: undefined as string | undefined,
}

let poller: Timer | undefined
let lastPollAt = 0

const storeKey = (sessionId: string) => `${STORE_PREFIX}${sessionId}`

async function readStored($: EngineInterface, key: string): Promise<StoredHandoff | undefined> {
  const value = (await $.store.get(key)) as Partial<StoredHandoff> | undefined
  return typeof value?.text === 'string' && typeof value.writtenAt === 'number'
    ? { text: value.text, writtenAt: value.writtenAt, cwd: String(value.cwd ?? '') }
    : undefined
}

async function pruneStore($: EngineInterface, now: number) {
  for (const key of await $.store.keys()) {
    if (!key.startsWith(STORE_PREFIX)) continue
    const stored = await readStored($, key)
    if (stored === undefined || now - stored.writtenAt > STORE_MAX_AGE_MS) await $.store.delete(key)
  }
}

function minutesToMs(value: string | undefined, fallbackMs: number) {
  const minutes = Number(value)
  return value !== undefined && Number.isFinite(minutes) && minutes > 0 ? minutes * MINUTE_MS : fallbackMs
}

// The tier of the newest main-thread cache write; a turn that only read the
// cache writes nothing, so older rows are searched until one wrote.
function cacheTier(transcript: string): CacheTier {
  const rows = transcript.split('\n')
  for (let i = rows.length - 1; i >= 0 && i >= rows.length - TIER_SCAN_ROWS; i--) {
    const row = rows[i]
    if (row === undefined || !row.includes('"cache_creation"')) continue
    try {
      const entry = JSON.parse(row)
      if (entry.type !== 'assistant' || entry.isSidechain) continue
      const written = entry.message?.usage?.cache_creation
      if (written?.ephemeral_1h_input_tokens > 0) return '1h'
      if (written?.ephemeral_5m_input_tokens > 0) return '5m'
    } catch {
      // a row still being written
    }
  }
  return 'unknown'
}

async function homeDir($: EngineInterface) {
  return (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
}

// classic.Stop may not reach this plugin (an organization's managed settings
// keep it from installed plugins), so the path is also derived the way Claude
// Code names its project folders.
async function transcriptPath($: EngineInterface) {
  if (idle.transcriptPath !== undefined) return idle.transcriptPath
  const project = (await $.session.cwd()).replace(/[^a-zA-Z0-9]/g, '-')
  return `${await homeDir($)}/.claude/projects/${project}/${await $.session.id()}.jsonl`
}

async function readTier($: EngineInterface): Promise<CacheTier> {
  const path = await transcriptPath($)
  // A long transcript is past the 4 MiB that $.fs.read takes, so read its tail.
  try {
    const tail = await $.process.run(['tail', '-n', String(TIER_SCAN_ROWS), path])
    if (tail.exitCode === 0) return cacheTier(tail.stdout)
  } catch {
    // no tail on PATH
  }
  try {
    return cacheTier(String(await $.fs.read(path)))
  } catch {
    return 'unknown'
  }
}

// The name /rename last gave this session; /rename writes it to the
// transcript as a custom-title row, anywhere in the file.
async function sessionTitle($: EngineInterface) {
  try {
    const found = await $.process.run(['grep', '-F', '"type":"custom-title"', await transcriptPath($)])
    const rows = found.stdout.trim().split('\n')
    const title = JSON.parse(rows[rows.length - 1] ?? '').customTitle
    return typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined
  } catch {
    return undefined
  }
}

async function writeHandoff($: EngineInterface, now: number) {
  const forked = await $.model.fork({ prompt: HANDOFF_PROMPT })
  if (!forked.isAnswered) {
    $.ui.log(`cache-handoff: no handoff written (${forked.reason})`)
    return
  }
  idle.forkedAt = now
  if (forked.text.trim() === NO_HANDOFF) {
    idle.isFinished = true
    $.ui.log('cache-handoff: the work is finished, no handoff kept')
    return
  }
  const stored: StoredHandoff = { text: forked.text, writtenAt: now, cwd: await $.session.cwd() }
  await $.store.set(storeKey(await $.session.id()), stored)
  $.ui.toast(`Cache handoff written at ${clockTime(now)}.`)
}

const pad = (n: number) => String(n).padStart(2, '0')

function clockTime(ms: number) {
  const at = new Date(ms)
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`
}

function dateTime(ms: number) {
  const at = new Date(ms)
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${clockTime(ms)}`
}

// Appended to a renamed conversation's title: YYYYMMDD_HHMMSS, no spaces.
function titleStamp(ms: number) {
  const at = new Date(ms)
  const date = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`
  return `${date}_${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
}

function coldNotice(coldAt: number, stored: StoredHandoff | undefined) {
  const cold = `Prompt cache cold since ${clockTime(coldAt)}`
  if (stored === undefined) {
    return `${cold}. The next prompt re-caches the whole transcript; /clear first to start lean.`
  }
  return `${cold}. Handoff written at ${clockTime(stored.writtenAt)}; /handoff now opens a new conversation from it.`
}

function showNotice($: EngineInterface, text: string) {
  idle.isNoticeShown = true
  $.ui.status(text)
  $.ui.toast(text)
}

// Swaps the cold conversation for a new one that the handoff opens, named
// after the old one, so the next prompt caches the handoff, not the transcript.
async function startFromHandoff($: EngineInterface, key: string, stored: StoredHandoff, now: number) {
  const oldId = await $.session.id()
  const title = await sessionTitle($)
  await $.command.run({ command: 'clear' })
  idle.transcriptPath = undefined
  idle.lastTurnEndAt = undefined
  idle.isArmed = false
  idle.pendingKey = key
  idle.pendingHandoff = [
    `<handoff from="session ${oldId}" written="${dateTime(stored.writtenAt)}">`,
    stored.text,
    '</handoff>',
    `The previous conversation is still there: claude --resume ${oldId}`,
  ].join('\n')
  if (title !== undefined) {
    // The new conversation is already open and carries the handoff, so a
    // refused rename only leaves it unnamed.
    try {
      await $.command.run({ command: 'rename', args: `${title}_${titleStamp(now)}` })
    } catch (error) {
      $.ui.log(`cache-handoff: rename refused, the new conversation stays unnamed: ${errorText(error)}`)
    }
  }
  showNotice($, `New conversation started from the handoff of ${clockTime(stored.writtenAt)}; your next prompt carries it.`)
}

async function handoffIfDue($: EngineInterface, now: number) {
  if (!idle.isArmed || now - (idle.lastTurnEndAt ?? now) < config.cacheTtlMs - config.leadMs) return
  // Disarm before forking: the fork reads the cache and so refreshes its TTL,
  // and only a real turn may arm the next handoff.
  idle.isArmed = false
  idle.isWriting = true
  try {
    // The turn's end may have come before its cache write reached the
    // transcript, so the tier is read again here.
    if ((await readTier($)) === '5m') {
      idle.cacheTtlMs = SHORT_CACHE_TTL_MS
      $.ui.log('cache-handoff: 5 minute cache tier, no handoff written')
      return
    }
    await writeHandoff($, now)
  } finally {
    idle.isWriting = false
  }
}

// After the handoff step, so the cold time counts the fork's refresh.
async function actIfCold($: EngineInterface, now: number) {
  if (config.coldAction === 'off' || idle.isFinished || idle.isColdHandled || idle.isArmed) return
  if (idle.lastTurnEndAt === undefined) return
  const coldAt = Math.max(idle.lastTurnEndAt, idle.forkedAt ?? 0) + idle.cacheTtlMs
  if (now < coldAt) return
  idle.isColdHandled = true
  const key = storeKey(await $.session.id())
  const stored = await readStored($, key)
  if (config.coldAction === 'new' && stored !== undefined) {
    try {
      await startFromHandoff($, key, stored, now)
      return
    } catch (error) {
      $.ui.log(`cache-handoff: new conversation failed, showing the notice: ${errorText(error)}`)
    }
  }
  showNotice($, coldNotice(coldAt, stored))
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function poll($: EngineInterface) {
  const now = await $.clock.now()
  lastPollAt = now
  if (idle.isInTurn || idle.isWriting || idle.lastTurnEndAt === undefined) return
  await handoffIfDue($, now)
  await actIfCold($, now)
}

// Starts the poll, or starts it again when it has gone quiet: no session.start
// fires after /clear, so a turn is the next chance to notice.
async function ensurePoller($: EngineInterface) {
  const now = await $.clock.now()
  if (poller !== undefined && now - lastPollAt < 3 * POLL_MS) return
  poller?.cancel()
  lastPollAt = now
  poller = $.clock.every(POLL_MS, () => void poll($))
}

async function handoffCommand($: EngineInterface, args: string) {
  const word = args.trim().toLowerCase()
  if (word === 'off') {
    idle.isDisabled = true
    idle.isArmed = false
    return 'cache-handoff is off for this session.'
  }
  if (word === 'on') {
    idle.isDisabled = false
    return 'cache-handoff is on; it arms when the next turn ends.'
  }
  const key = storeKey(await $.session.id())
  const stored = await readStored($, key)
  if (word === 'now') {
    if (stored === undefined) return 'No handoff is stored for this session.'
    // $.command.run waits for the session to be idle, which it is not while
    // this command runs, so the switch happens just after.
    $.clock.after(0, () => {
      void (async () => {
        try {
          idle.isColdHandled = true
          await startFromHandoff($, key, stored, await $.clock.now())
        } catch (error) {
          $.ui.toast(`cache-handoff: could not open the new conversation: ${errorText(error)}`)
        }
      })()
    })
    return `Opening a new conversation from the handoff of ${clockTime(stored.writtenAt)}.`
  }
  const state = idle.isDisabled ? 'off' : idle.isArmed ? 'armed' : 'waiting for the next turn'
  const handoff = stored === undefined ? 'no handoff stored' : `handoff stored at ${clockTime(stored.writtenAt)}`
  return `cache-handoff: ${state}, ${handoff}, coldAction ${config.coldAction}. Usage: /handoff off | on | now`
}

export const register: Register = (on, options) => {
  const action = options.coldAction
  // 0.3.0 called the default new-session.
  config.coldAction = action === 'notice' || action === 'off' ? action : 'new'

  on('session.start', async ($, e, next) => {
    config.cacheTtlMs = minutesToMs(await $.env.get('CACHE_HANDOFF_TTL_MIN'), 60 * MINUTE_MS)
    config.leadMs = minutesToMs(await $.env.get('CACHE_HANDOFF_LEAD_MIN'), 6 * MINUTE_MS)
    idle.cacheTtlMs = config.cacheTtlMs
    await $.command.register({
      name: 'handoff',
      description: 'Cache handoff: off, on, or now to open a new conversation from the stored handoff',
      argumentHint: 'off | on | now',
    })
    await ensurePoller($)
    const now = await $.clock.now()
    await pruneStore($, now)
    // A session resumed after Claude Code closed before its cache went cold.
    const stored = await readStored($, storeKey(await $.session.id()))
    if (stored !== undefined) {
      showNotice($, `A handoff from ${dateTime(stored.writtenAt)} is stored; /handoff now opens a new conversation from it.`)
    }
    return next(e)
  })

  on('command.run', { command: 'handoff' }, async ($, e) => ({ text: await handoffCommand($, e.args) }))

  // The first prompt the person types in the new conversation opens with the
  // handoff; a notification or a peer's message does not take it.
  on('prompt.submit', async ($, e, next) => {
    if (idle.pendingHandoff === undefined || e.command !== undefined || e.isMeta || e.origin.kind !== 'composer') {
      return next(e)
    }
    const text = `${idle.pendingHandoff}\n\n${e.text}`
    if (idle.pendingKey !== undefined) await $.store.delete(idle.pendingKey)
    idle.pendingHandoff = undefined
    idle.pendingKey = undefined
    return next({ ...e, text })
  }).catch(($, e, next) => next(e))

  // Turns raised while the handoff forks are the mod's own, never the person's.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && !idle.isWriting) {
      idle.isInTurn = true
      // The person is back in this conversation: its handoff is moot.
      if (idle.pendingHandoff === undefined) await $.store.delete(storeKey(await $.session.id()))
      if (idle.isNoticeShown) {
        idle.isNoticeShown = false
        $.ui.status(undefined)
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && !idle.isWriting) {
      idle.isInTurn = false
      idle.lastTurnEndAt = await $.clock.now()
      idle.cacheTtlMs = config.cacheTtlMs
      idle.forkedAt = undefined
      idle.isFinished = false
      const tokens = (await $.session.usage()).context.tokens ?? 0
      const isWatched = !idle.isDisabled && tokens >= MIN_CONTEXT_TOKENS
      // A gap the mod sits out ends quietly, with no notice at cold either.
      idle.isColdHandled = !isWatched
      // On the 5m tier the cache is cold long before a handoff could be
      // written, so skip it and let the notice come at the 5m mark.
      if (isWatched && (await readTier($)) === '5m') {
        idle.cacheTtlMs = SHORT_CACHE_TTL_MS
        idle.isArmed = false
      } else {
        idle.isArmed = isWatched
      }
      await ensurePoller($)
    }
    return next(e)
  })

  on('classic.Stop', ($, e, next) => {
    idle.transcriptPath = e.transcript_path
    return next(e)
  }).catch(($, e, next) => next(e))
}
