import type { On } from 'claude-code'
import { expect, mock, test, type TestBody } from 'claude-code/testing'

const MINUTE = 60_000
// How the person typing a slash command reaches command.run.
const typed = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }

type EngineOptions = {
  title?: string
  isCommandRefused?: boolean
  refusedCommand?: string
  contextTokens?: number
  forkText?: string
  stored?: Record<string, unknown>
}

// The engine beneath the mod: one session titled `title`, a transcript tail of
// `tail`; the store, status lines, slash commands and the prompts that reach
// the model are collected.
function engine(on: On, tail: string, options: EngineOptions = {}) {
  const { title = 'My work', isCommandRefused = false, contextTokens = 120_000, forkText = 'handoff body' } = options
  const store = new Map<string, unknown>(Object.entries(options.stored ?? {}))
  const statuses: (string | undefined)[] = []
  const commands: string[] = []
  const prompts: string[] = []
  const forks: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('command.run', ($, e) => {
    if (isCommandRefused || e.command === options.refusedCommand) throw new Error('refused')
    commands.push([e.command, e.args].filter(Boolean).join(' '))
    return { text: '' }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: 'D:/ws/demo' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: contextTokens, window: 1_000_000 }, rateLimits: [] },
  }))
  on('env.get', () => ({ value: undefined }))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('process.run', ($, e) => {
    const stdout = e.argv[0] === 'grep' ? JSON.stringify({ type: 'custom-title', customTitle: title }) : tail
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', () => {
    throw new Error('no such file')
  })
  on('model.fork', ($, e) => {
    forks.push(String(e.prompt))
    return {
      value: {
        isAnswered: true,
        text: forkText,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  return { store, statuses, commands, prompts, forks }
}

function cacheWrite(tier: '1h' | '5m') {
  return JSON.stringify({
    type: 'assistant',
    message: {
      usage: {
        cache_creation: {
          ephemeral_1h_input_tokens: tier === '1h' ? 5000 : 0,
          ephemeral_5m_input_tokens: tier === '5m' ? 5000 : 0,
        },
      },
    },
  })
}

async function oneTurn($: Parameters<TestBody>[0]) {
  await $.session.start({ cwd: 'D:/ws/demo', surface: null, isInteractive: true })
  await $.turn.start({ text: 'build the mod', turnId: 't1' })
  await $.turn.complete({ answer: 'done', reason: 'answer', durationMs: 1000, isAborted: false, turnId: 't1' })
}

test('writes the handoff, then opens a new named conversation once the refreshed cache is cold', async ($, on) => {
  const clock = mock.clock(on)
  const { store, commands, prompts } = engine(on, cacheWrite('1h'))
  await oneTurn($)

  await clock.advance(53 * MINUTE)
  expect(store.size).toBe(0)

  await clock.advance(2 * MINUTE)
  expect(store.size).toBe(1)
  expect(JSON.stringify(store.get('handoff:session-1'))).toContain('handoff body')

  // The fork at 54 minutes kept the cache warm until 114.
  await clock.advance(58 * MINUTE)
  expect(commands.length).toBe(0)

  await clock.advance(2 * MINUTE)
  expect(commands[0]).toBe('clear')
  expect(commands[1]).toMatch(/^rename My work_\d{8}_\d{6}$/)

  await clock.advance(3 * 60 * MINUTE)
  expect(commands.length).toBe(2)

  await $.prompt.submit({ text: 'carry on', wait: false, origin: { kind: 'composer' } })
  expect(prompts[0]).toContain('handoff body')
  expect(prompts[0]).toContain('claude --resume session-1')
  expect(prompts[0]).toEndWith('carry on')
  expect(store.size).toBe(0)

  await $.prompt.submit({ text: 'and then', wait: false, origin: { kind: 'composer' } })
  expect(prompts[1]).toBe('and then')
})

test('leaves an unnamed conversation unnamed', async ($, on) => {
  const clock = mock.clock(on)
  const { commands } = engine(on, cacheWrite('1h'), { title: '' })
  await oneTurn($)

  await clock.advance(2 * 60 * MINUTE)
  expect(commands).toEqual(['clear'])
})

test('sits out a conversation under 50k tokens', async ($, on) => {
  const clock = mock.clock(on)
  const { forks, statuses, commands } = engine(on, cacheWrite('1h'), { contextTokens: 20_000 })
  await oneTurn($)

  await clock.advance(3 * 60 * MINUTE)
  expect(forks.length).toBe(0)
  expect(commands.length).toBe(0)
  expect(statuses.length).toBe(0)
})

test('keeps nothing and does nothing at cold when the work is finished', async ($, on) => {
  const clock = mock.clock(on)
  const { forks, store, statuses, commands } = engine(on, cacheWrite('1h'), { forkText: 'NO_HANDOFF' })
  await oneTurn($)

  await clock.advance(3 * 60 * MINUTE)
  expect(forks.length).toBe(1)
  expect(store.size).toBe(0)
  expect(commands.length).toBe(0)
  expect(statuses.length).toBe(0)
})

test('pins the notice when the new conversation is refused', async ($, on) => {
  const clock = mock.clock(on)
  const { statuses } = engine(on, cacheWrite('1h'), { isCommandRefused: true })
  await oneTurn($)

  await clock.advance(2 * 60 * MINUTE)
  expect(statuses.length).toBe(1)
  expect(statuses[0]).toContain('/handoff now')
})

test('a refused rename leaves the new conversation unnamed and still carries the handoff', async ($, on) => {
  const clock = mock.clock(on)
  const { statuses, commands, prompts } = engine(on, cacheWrite('1h'), { refusedCommand: 'rename' })
  await oneTurn($)

  await clock.advance(2 * 60 * MINUTE)
  expect(commands).toEqual(['clear'])
  expect(statuses[0]).toContain('New conversation started')

  await $.prompt.submit({ text: 'carry on', wait: false, origin: { kind: 'composer' } })
  expect(prompts[0]).toContain('handoff body')
})

test('writes nothing on the 5 minute cache tier and says so once that cache is cold', async ($, on) => {
  const clock = mock.clock(on)
  const { store, statuses, commands, forks } = engine(on, cacheWrite('5m'))
  await oneTurn($)

  await clock.advance(4 * MINUTE)
  expect(statuses.length).toBe(0)

  await clock.advance(2 * MINUTE)
  expect(statuses[0]).toContain('/clear first')

  await clock.advance(2 * 60 * MINUTE)
  expect(forks.length).toBe(0)
  expect(store.size).toBe(0)
  expect(commands.length).toBe(0)
  expect(statuses.length).toBe(1)

  await $.turn.start({ text: 'back again', turnId: 't2' })
  expect(statuses[1]).toBe(undefined)
})

test('a prompt in the old conversation drops its stored handoff', async ($, on) => {
  const clock = mock.clock(on)
  const { store } = engine(on, cacheWrite('1h'))
  await oneTurn($)

  await clock.advance(60 * MINUTE)
  expect(store.size).toBe(1)

  await $.turn.start({ text: 'back before cold', turnId: 't2' })
  expect(store.size).toBe(0)
})

test('only pins the notice with coldAction notice', { options: { coldAction: 'notice' } }, async ($, on) => {
  const clock = mock.clock(on)
  const { statuses, commands } = engine(on, cacheWrite('1h'))
  await oneTurn($)

  await clock.advance(2 * 60 * MINUTE)
  expect(commands.length).toBe(0)
  expect(statuses[0]).toContain('Handoff written at')
})

test('does nothing once cold with coldAction off', { options: { coldAction: 'off' } }, async ($, on) => {
  const clock = mock.clock(on)
  const { store, statuses, commands } = engine(on, cacheWrite('1h'))
  await oneTurn($)

  await clock.advance(3 * 60 * MINUTE)
  expect(store.size).toBe(1)
  expect(statuses.length).toBe(0)
  expect(commands.length).toBe(0)
})

test('/handoff off sits out the next gap', async ($, on) => {
  const clock = mock.clock(on)
  const { forks, commands } = engine(on, cacheWrite('1h'))
  await $.session.start({ cwd: 'D:/ws/demo', surface: null, isInteractive: true })
  await $.command.run({ command: 'handoff', args: 'off', ...typed })
  await $.turn.start({ text: 'build the mod', turnId: 't1' })
  await $.turn.complete({ answer: 'done', reason: 'answer', durationMs: 1000, isAborted: false, turnId: 't1' })

  await clock.advance(3 * 60 * MINUTE)
  expect(forks.length).toBe(0)
  expect(commands.length).toBe(0)
})

test('a resumed session with a stored handoff offers it, and /handoff now opens it', async ($, on) => {
  const clock = mock.clock(on, { now: 10 * MINUTE })
  const { statuses, commands, prompts, store } = engine(on, cacheWrite('1h'), {
    stored: { 'handoff:session-1': { text: 'stored body', writtenAt: 5 * MINUTE, cwd: 'D:/ws/demo' } },
  })
  await $.session.start({ cwd: 'D:/ws/demo', surface: null, isInteractive: true })
  expect(statuses[0]).toContain('/handoff now')

  const answer = await $.command.run({ command: 'handoff', args: 'now', ...typed })
  expect(answer.text).toContain('Opening a new conversation')
  await clock.advance(1)
  expect(commands[0]).toBe('clear')

  await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })
  expect(prompts[0]).toContain('stored body')
  expect(store.size).toBe(0)
})
