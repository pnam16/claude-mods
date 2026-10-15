import type { EngineInterface, Register } from 'claude-code'

// Answers the questions cache-handoff 0.4.0 rests on, in a live session:
// does $.command.run run /clear and /rename from a timer while idle, does the
// timer outlive /clear, is grep on PATH, and does the first typed prompt of
// the new conversation take the carried text. Every step lands in probe.log.

const TICK_MS = 5_000
const LOG_EVERY_MS = 30_000

const probe = {
  lastTurnEndAt: undefined as number | undefined,
  isArmed: false,
  isInTurn: false,
  hasRun: false,
  isTimerStarted: false,
  lastTickLoggedAt: 0,
  pending: undefined as string | undefined,
  lines: [] as string[],
}

const pad = (n: number) => String(n).padStart(2, '0')

function dateTime(ms: number) {
  const at = new Date(ms)
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function log($: EngineInterface, text: string) {
  const line = `${dateTime(await $.clock.now())} ${text}`
  probe.lines.push(line)
  $.ui.log(`clear-probe: ${text}`)
  try {
    await $.fs.write(`${$.plugin.root}/probe.log`, `${probe.lines.join('\n')}\n`)
  } catch (error) {
    $.ui.log(`clear-probe: cannot write probe.log: ${message(error)}`)
  }
}

async function delayMs($: EngineInterface) {
  const seconds = Number(await $.env.get('CLEAR_PROBE_DELAY_S'))
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000
}

async function homeDir($: EngineInterface) {
  return (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
}

async function transcriptPath($: EngineInterface) {
  const project = (await $.session.cwd()).replace(/[^a-zA-Z0-9]/g, '-')
  return `${await homeDir($)}/.claude/projects/${project}/${await $.session.id()}.jsonl`
}

async function readTitle($: EngineInterface) {
  const path = await transcriptPath($)
  try {
    const found = await $.process.run(['grep', '-F', '"type":"custom-title"', path])
    await log($, `grep ran: exit ${found.exitCode}, ${found.stdout.trim().split('\n').filter(Boolean).length} title rows, path ${path}`)
    const rows = found.stdout.trim().split('\n')
    const title = JSON.parse(rows[rows.length - 1] || '{}').customTitle
    return typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined
  } catch (error) {
    await log($, `grep failed: ${message(error)}`)
    return undefined
  }
}

async function runStep($: EngineInterface, now: number) {
  probe.hasRun = true
  const oldId = await $.session.id()
  await log($, `step start, old session ${oldId}`)
  const title = await readTitle($)
  await log($, `old title: ${title ?? '(none)'}`)

  try {
    await $.command.run({ command: 'clear' })
    await log($, `/clear resolved, session now ${await $.session.id()}`)
  } catch (error) {
    await log($, `/clear refused: ${message(error)}`)
    return
  }

  // Renamed even when untitled, so the probe also proves /rename runs.
  const name = `${title ?? 'clear-probe'} ${dateTime(now).slice(0, 16)}`
  try {
    await $.command.run({ command: 'rename', args: name })
    await log($, `/rename resolved: ${name}`)
  } catch (error) {
    await log($, `/rename refused: ${message(error)}`)
  }

  probe.pending = `<probe-handoff from="session ${oldId}">clear-probe carried this line.</probe-handoff>`
  $.ui.status('clear-probe: new conversation opened; your next prompt carries the probe line.')
}

async function tick($: EngineInterface) {
  const now = await $.clock.now()
  if (now - probe.lastTickLoggedAt >= LOG_EVERY_MS) {
    probe.lastTickLoggedAt = now
    await log($, `tick, session ${await $.session.id()}`)
  }
  if (!probe.isArmed || probe.hasRun || probe.isInTurn || probe.lastTurnEndAt === undefined) return
  if (now - probe.lastTurnEndAt < (await delayMs($))) return
  probe.isArmed = false
  await runStep($, now)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await log($, `session.start, session ${await $.session.id()}`)
    // A reload fires session.start again; one timer is enough.
    if (!probe.isTimerStarted) {
      probe.isTimerStarted = true
      $.clock.every(TICK_MS, () => void tick($))
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await log($, `session.end, reason ${e.reason}, session ${e.sessionId}`)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (probe.pending === undefined || e.command !== undefined || e.isMeta || e.origin.kind !== 'composer') {
      return next(e)
    }
    const text = `${probe.pending}\n\n${e.text}`
    probe.pending = undefined
    await log($, `carried the probe line into the first prompt of session ${await $.session.id()}`)
    $.ui.status(undefined)
    return next({ ...e, text })
  }).catch(($, e, next) => next(e))

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) probe.isInTurn = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      probe.isInTurn = false
      if (!probe.hasRun) {
        probe.isArmed = true
        probe.lastTurnEndAt = await $.clock.now()
        await log($, `armed; /clear runs after ${(await delayMs($)) / 1000}s idle`)
      }
    }
    return next(e)
  })
}
