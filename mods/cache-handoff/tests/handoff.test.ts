import type {On} from "claude-code";
import {expect, mock, type TestBody, test} from "claude-code/testing";

const MINUTE = 60_000;
// How the person typing a slash command reaches command.run.
const typed = {
  origin: {kind: "composer" as const},
  presentation: {columns: 120, isFullscreen: false},
};

type EngineOptions = {
  title?: string;
  isCommandRefused?: boolean;
  refusedCommand?: string;
  // A command name another plugin already owns.
  takenName?: string;
  contextTokens?: number;
  forkText?: string;
  stored?: Record<string, unknown>;
  env?: Record<string, string>;
  // Runs while the fork is answering, as a person typing meanwhile.
  duringFork?: () => Promise<void>;
};

// The engine beneath the mod: one session titled `title`, a transcript tail of
// `tail` (or what it returns at each read); the store, status lines, slash commands and the prompts that reach
// the model are collected.
const engine = (
  on: On,
  tail: string | (() => string),
  options: EngineOptions = {},
) => {
  const {
    title = "My work",
    isCommandRefused = false,
    contextTokens = 120_000,
    forkText = "handoff body",
  } = options;
  const store = new Map<string, unknown>(Object.entries(options.stored ?? {}));
  const statuses: (string | undefined)[] = [];
  const commands: string[] = [];
  const prompts: string[] = [];
  const forks: string[] = [];
  const notices: string[] = [];
  on("session.append", (_$, e, next) => {
    notices.push(
      e.message.content
        .map((block) => String((block as {text?: string}).text ?? ""))
        .join(""),
    );
    return next(e);
  });
  on("session.start", (_$, e) => ({cwd: e.cwd}));
  on("turn.start", (_$, e) => ({turnId: e.turnId}));
  on("turn.complete", (_$, e) => ({text: e.answer}));
  on("prompt.submit", (_$, e) => {
    prompts.push(e.text);
    return {text: e.text};
  });
  on("command.run", (_$, e) => {
    if (isCommandRefused || e.command === options.refusedCommand)
      throw new Error("refused");
    commands.push([e.command, e.args].filter(Boolean).join(" "));
    return {text: ""};
  });
  on("command.register", (_$, e) => {
    if (e.name === options.takenName) throw new Error(`"/${e.name}" refused`);
    return {value: {command: e.name}};
  });
  on("session.id", () => ({value: "session-1"}));
  on("session.cwd", () => ({value: "D:/ws/demo"}));
  on("session.usage", () => ({
    value: {
      context: {tokens: contextTokens, window: 1_000_000},
      rateLimits: [],
      startedAt: 0,
    },
  }));
  on("env.get", (_$, e) => ({value: options.env?.[e.name]}));
  on("store.get", (_$, e) => ({value: store.get(e.key)}));
  on("store.set", (_$, e) => {
    store.set(e.key, e.value);
    return {value: undefined};
  });
  on("store.delete", (_$, e) => {
    store.delete(e.key);
    return {value: undefined};
  });
  on("store.keys", () => ({value: [...store.keys()]}));
  on("process.run", (_$, e) => {
    const stdout =
      e.argv[0] === "grep"
        ? JSON.stringify({customTitle: title, type: "custom-title"})
        : typeof tail === "string"
          ? tail
          : tail();
    return {
      value: {
        exitCode: 0,
        isStderrTruncated: false,
        isStdoutTruncated: false,
        stderr: "",
        stdout,
      },
    };
  });
  on("fs.read", () => {
    throw new Error("no such file");
  });
  on("model.fork", async (_$, e) => {
    forks.push(String(e.prompt));
    await options.duringFork?.();
    return {
      value: {
        isAnswered: true,
        text: forkText,
        usage: {
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
        },
      },
    };
  });
  on("ui.status", (_$, e) => {
    statuses.push(e.text);
    return {value: undefined};
  });
  on("ui.toast", () => ({value: undefined}));
  on("ui.log", () => ({value: undefined}));
  return {commands, forks, notices, prompts, statuses, store};
};

const cacheWrite = (tier: "1h" | "5m") => {
  return JSON.stringify({
    message: {
      usage: {
        cache_creation: {
          ephemeral_1h_input_tokens: tier === "1h" ? 5000 : 0,
          ephemeral_5m_input_tokens: tier === "5m" ? 5000 : 0,
        },
      },
    },
    type: "assistant",
  });
};

const oneTurn = async ($: Parameters<TestBody>[0]) => {
  await $.session.start({
    cwd: "D:/ws/demo",
    isInteractive: true,
    surface: null,
  });
  await $.turn.start({text: "build the mod", turnId: "t1"});
  await $.turn.complete({
    answer: "done",
    durationMs: 1000,
    isAborted: false,
    reason: "answer",
    turnId: "t1",
  });
};

test("writes the handoff, then opens a new named conversation once the refreshed cache is cold", async ($, on) => {
  const clock = mock.clock(on);
  const {store, commands, prompts, notices} = engine(on, cacheWrite("1h"));
  await oneTurn($);

  await clock.advance(53 * MINUTE);
  expect(store.size).toBe(0);

  await clock.advance(2 * MINUTE);
  expect(store.size).toBe(1);
  expect(JSON.stringify(store.get("handoff:session-1"))).toContain(
    "handoff body",
  );

  // The fork at 54 minutes kept the cache warm until 114.
  await clock.advance(58 * MINUTE);
  expect(commands.length).toBe(0);

  await clock.advance(2 * MINUTE);
  expect(commands[0]).toBe("clear");
  expect(commands[1]).toMatch(/^rename My work_\d{8}_\d{6}$/);
  // The person sees the handoff on the cleared screen before typing.
  expect(notices.length).toBe(1);
  expect(notices[0]).toContain("handoff body");
  expect(notices[0]).toContain("claude --resume session-1");

  await clock.advance(3 * 60 * MINUTE);
  expect(commands.length).toBe(2);

  await $.prompt.submit({
    origin: {kind: "composer"},
    text: "carry on",
    wait: false,
  });
  expect(prompts[0]).toContain("handoff body");
  expect(prompts[0]).toContain("claude --resume session-1");
  expect(prompts[0]).toEndWith("carry on");
  expect(store.size).toBe(0);

  await $.prompt.submit({
    origin: {kind: "composer"},
    text: "and then",
    wait: false,
  });
  expect(prompts[1]).toBe("and then");
});

// A conversation handed off again keeps one stamp, whatever earlier
// handoffs left on its title.
for (const title of [
  "KJMTP2-6178_20261015_150400",
  "KJMTP2-6178_2026-10-15 13:04",
  "KJMTP2-6178_20261015_150400_20261015_170400",
]) {
  test(`replaces the stamp on "${title}" instead of adding another`, async ($, on) => {
    const clock = mock.clock(on);
    const {commands} = engine(on, cacheWrite("1h"), {title});
    await oneTurn($);
    await clock.advance(2 * 60 * MINUTE);
    expect(commands[1]).toMatch(/^rename KJMTP2-6178_\d{8}_\d{6}$/);
  });
}

test("leaves an unnamed conversation unnamed", async ($, on) => {
  const clock = mock.clock(on);
  const {commands} = engine(on, cacheWrite("1h"), {title: ""});
  await oneTurn($);

  await clock.advance(2 * 60 * MINUTE);
  expect(commands).toEqual(["clear"]);
});

test("sits out a conversation under 50k tokens", async ($, on) => {
  const clock = mock.clock(on);
  const {forks, statuses, commands} = engine(on, cacheWrite("1h"), {
    contextTokens: 20_000,
  });
  await oneTurn($);

  await clock.advance(3 * 60 * MINUTE);
  expect(forks.length).toBe(0);
  expect(commands.length).toBe(0);
  expect(statuses.length).toBe(0);
});

test("keeps nothing and does nothing at cold when the work is finished", async ($, on) => {
  const clock = mock.clock(on);
  const {forks, store, statuses, commands} = engine(on, cacheWrite("1h"), {
    forkText: "NO_HANDOFF",
  });
  await oneTurn($);

  await clock.advance(3 * 60 * MINUTE);
  expect(forks.length).toBe(1);
  expect(store.size).toBe(0);
  expect(commands.length).toBe(0);
  expect(statuses.length).toBe(0);
});

test("pins the notice when the new conversation is refused", async ($, on) => {
  const clock = mock.clock(on);
  const {statuses} = engine(on, cacheWrite("1h"), {isCommandRefused: true});
  await oneTurn($);

  await clock.advance(2 * 60 * MINUTE);
  expect(statuses.length).toBe(1);
  expect(statuses[0]).toContain("/handoff now");
});

test("a refused rename leaves the new conversation unnamed and still carries the handoff", async ($, on) => {
  const clock = mock.clock(on);
  const {statuses, commands, prompts} = engine(on, cacheWrite("1h"), {
    refusedCommand: "rename",
  });
  await oneTurn($);

  await clock.advance(2 * 60 * MINUTE);
  expect(commands).toEqual(["clear"]);
  expect(statuses[0]).toContain("Continued from the handoff");

  await $.prompt.submit({
    origin: {kind: "composer"},
    text: "carry on",
    wait: false,
  });
  expect(prompts[0]).toContain("handoff body");
});

test("does nothing at all on the 5 minute cache tier", async ($, on) => {
  const clock = mock.clock(on);
  const {store, statuses, commands, forks} = engine(on, cacheWrite("5m"));
  await oneTurn($);

  await clock.advance(2 * 60 * MINUTE);
  expect(forks.length).toBe(0);
  expect(store.size).toBe(0);
  expect(commands.length).toBe(0);
  expect(statuses.length).toBe(0);
});

test("a 5 minute tier seen only at the handoff mark ends the gap quietly", async ($, on) => {
  const clock = mock.clock(on);
  // The turn's cache write reaches the transcript only after its end.
  let tail = "";
  const {store, statuses, commands, forks} = engine(on, () => tail);
  await oneTurn($);
  tail = cacheWrite("5m");

  await clock.advance(2 * 60 * MINUTE);
  expect(forks.length).toBe(0);
  expect(store.size).toBe(0);
  expect(commands.length).toBe(0);
  expect(statuses.length).toBe(0);
});

test("a machine that slept past cold writes no handoff and shows the notice", async ($, on) => {
  const clock = mock.clock(on);
  // A 15s cache under the 30s poll: the first poll after the turn is already
  // past cold, as the first one after a suspended laptop wakes is.
  const env = {CACHE_HANDOFF_LEAD_MIN: "0.2", CACHE_HANDOFF_TTL_MIN: "0.25"};
  const {store, statuses, commands, forks} = engine(on, cacheWrite("1h"), {
    env,
  });
  await oneTurn($);

  await clock.advance(MINUTE);
  expect(forks.length).toBe(0);
  expect(store.size).toBe(0);
  expect(commands.length).toBe(0);
  expect(statuses[0]).toContain("/clear first");
});

test("a prompt typed while the handoff forks keeps no handoff and clears nothing", async ($, on) => {
  const clock = mock.clock(on);
  const {store, statuses, commands, forks} = engine(on, cacheWrite("1h"), {
    duringFork: async () => {
      await $.prompt.submit({
        origin: {kind: "composer"},
        text: "back already",
        wait: false,
      });
    },
  });
  await oneTurn($);

  await clock.advance(2 * 60 * MINUTE);
  expect(forks.length).toBe(1);
  expect(store.size).toBe(0);
  expect(commands.length).toBe(0);
  expect(statuses.length).toBe(0);
});

test("a prompt in the old conversation drops its stored handoff", async ($, on) => {
  const clock = mock.clock(on);
  const {store} = engine(on, cacheWrite("1h"));
  await oneTurn($);

  await clock.advance(60 * MINUTE);
  expect(store.size).toBe(1);

  await $.turn.start({text: "back before cold", turnId: "t2"});
  expect(store.size).toBe(0);
});

test(
  "only pins the notice with coldAction notice",
  {options: {coldAction: "notice"}},
  async ($, on) => {
    const clock = mock.clock(on);
    const {statuses, commands} = engine(on, cacheWrite("1h"));
    await oneTurn($);

    await clock.advance(2 * 60 * MINUTE);
    expect(commands.length).toBe(0);
    expect(statuses[0]).toContain("continue from the handoff of");
  },
);

test(
  "does nothing once cold with coldAction off",
  {options: {coldAction: "off"}},
  async ($, on) => {
    const clock = mock.clock(on);
    const {store, statuses, commands} = engine(on, cacheWrite("1h"));
    await oneTurn($);

    await clock.advance(3 * 60 * MINUTE);
    expect(store.size).toBe(1);
    expect(statuses.length).toBe(0);
    expect(commands.length).toBe(0);
  },
);

test("/handoff off sits out the next gap", async ($, on) => {
  const clock = mock.clock(on);
  const {forks, commands} = engine(on, cacheWrite("1h"));
  await $.session.start({
    cwd: "D:/ws/demo",
    isInteractive: true,
    surface: null,
  });
  await $.command.run({args: "off", command: "handoff", ...typed});
  await $.turn.start({text: "build the mod", turnId: "t1"});
  await $.turn.complete({
    answer: "done",
    durationMs: 1000,
    isAborted: false,
    reason: "answer",
    turnId: "t1",
  });

  await clock.advance(3 * 60 * MINUTE);
  expect(forks.length).toBe(0);
  expect(commands.length).toBe(0);
});

test("a resumed session with a stored handoff offers it, and /handoff now opens it", async ($, on) => {
  const clock = mock.clock(on, {now: 10 * MINUTE});
  const {statuses, commands, prompts, store} = engine(on, cacheWrite("1h"), {
    stored: {
      "handoff:session-1": {
        cwd: "D:/ws/demo",
        text: "stored body",
        writtenAt: 5 * MINUTE,
      },
    },
  });
  await $.session.start({
    cwd: "D:/ws/demo",
    isInteractive: true,
    surface: null,
  });
  expect(statuses[0]).toContain("/handoff now");

  const answer = await $.command.run({
    args: "now",
    command: "handoff",
    ...typed,
  });
  expect(answer.text).toContain("Opening a new conversation");
  await clock.advance(1);
  expect(commands[0]).toBe("clear");

  await $.prompt.submit({origin: {kind: "composer"}, text: "go", wait: false});
  expect(prompts[0]).toContain("stored body");
  expect(store.size).toBe(0);
});

test("a taken /handoff falls back to /cache-handoff and session.start runs on", async ($, on) => {
  mock.clock(on, {now: 10 * MINUTE});
  const {statuses} = engine(on, cacheWrite("1h"), {
    stored: {
      "handoff:session-1": {
        cwd: "D:/ws/demo",
        text: "stored body",
        writtenAt: 5 * MINUTE,
      },
    },
    takenName: "handoff",
  });
  await $.session.start({
    cwd: "D:/ws/demo",
    isInteractive: true,
    surface: null,
  });
  expect(statuses[0]).toContain("/cache-handoff now");

  const answer = await $.command.run({
    args: "",
    command: "cache-handoff",
    ...typed,
  });
  expect(answer.text).toContain("Usage: /cache-handoff off | on | now");
});
