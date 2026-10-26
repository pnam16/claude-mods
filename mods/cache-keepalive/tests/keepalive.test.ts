import type {On} from "claude-code";
import {expect, mock, type TestBody, test} from "claude-code/testing";

const MINUTE = 60_000;

// The engine beneath the mod: a 1h-tier transcript tail, and a fork that
// reads `cacheRead` tokens from the cache; the forks are counted.
const engine = (on: On, cacheRead = 100_000) => {
  const forks: string[] = [];
  on("session.start", (_$, e) => ({cwd: e.cwd}));
  on("turn.start", (_$, e) => ({turnId: e.turnId}));
  on("turn.complete", (_$, e) => ({text: e.answer}));
  on("command.register", (_$, e) => ({value: {command: e.name}}));
  on("session.id", () => ({value: "session-1"}));
  on("session.cwd", () => ({value: "D:/ws/demo"}));
  on("env.get", () => ({value: undefined}));
  on("process.run", () => {
    const stdout = JSON.stringify({
      message: {usage: {cache_creation: {ephemeral_1h_input_tokens: 5000}}},
      type: "assistant",
    });
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
  on("model.fork", (_$, e) => {
    forks.push(String(e.prompt));
    return {
      value: {
        isAnswered: true,
        text: "ok",
        usage: {
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: cacheRead,
          input_tokens: 0,
          output_tokens: 0,
        },
      },
    };
  });
  on("ui.log", () => ({value: undefined}));
  return {forks};
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

test("refreshes 5 minutes before each expiry and stops at the 3 hour idle limit", async ($, on) => {
  const clock = mock.clock(on);
  const {forks} = engine(on);
  await oneTurn($);

  await clock.advance(54 * MINUTE);
  expect(forks.length).toBe(0);

  await clock.advance(2 * MINUTE);
  expect(forks.length).toBe(1);

  // Each refresh starts the next hour.
  await clock.advance(55 * MINUTE);
  expect(forks.length).toBe(2);

  await clock.advance(5 * 60 * MINUTE);
  expect(forks.length).toBe(3);
});

test("stops when a refresh finds the cache already cold", async ($, on) => {
  const clock = mock.clock(on);
  const {forks} = engine(on, 0);
  await oneTurn($);

  await clock.advance(5 * 60 * MINUTE);
  expect(forks.length).toBe(1);
});
