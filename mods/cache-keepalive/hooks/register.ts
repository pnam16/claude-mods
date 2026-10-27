import type {EngineInterface, Register, Timer} from "claude-code";

const MINUTE_MS = 60_000;
const POLL_MS = 30_000;
// A refresh goes out this long before the cache would expire.
const LEAD_MS = {"1h": 5 * MINUTE_MS, "5m": MINUTE_MS};
const TTL_MS = {"1h": 60 * MINUTE_MS, "5m": 5 * MINUTE_MS};
// Rows read back from the transcript's end when looking for the cache tier.
const TIER_SCAN_ROWS = 400;
// A refresh that read less than this from the cache found it already cold.
const MIN_CACHE_READ_TOKENS = 1_000;
const PING_PROMPT = "Keep-alive ping. Reply with exactly: ok";

type CacheTier = "1h" | "5m";

const config = {
  maxIdleMs: 3 * 60 * MINUTE_MS,
  // Overrides the tier's TTL so a live test can shorten it.
  ttlOverrideMs: undefined as number | undefined,
};

// The module's own, so a reload starts it over.
const idle = {
  isDisabled: false,
  isInTurn: false,
  isPinging: false,
  isStopped: true,
  // The last time the cache was read: the turn's end or the latest refresh.
  lastReadAt: undefined as number | undefined,
  lastTurnEndAt: undefined as number | undefined,
  refreshes: 0,
  tier: "1h" as CacheTier,
  transcriptPath: undefined as string | undefined,
};

let poller: Timer | undefined;
let lastPollAt = 0;

const hoursToMs = (value: unknown, fallbackMs: number) => {
  const hours = Number(value);
  return Number.isFinite(hours) && hours > 0
    ? hours * 60 * MINUTE_MS
    : fallbackMs;
};

// The tier of the newest main-thread cache write; a turn that only read the
// cache writes nothing, so older rows are searched until one wrote.
const cacheTier = (transcript: string): CacheTier => {
  const rows = transcript.split("\n");
  for (
    let i = rows.length - 1;
    i >= 0 && i >= rows.length - TIER_SCAN_ROWS;
    i--
  ) {
    const row = rows[i];
    if (row === undefined || !row.includes('"cache_creation"')) continue;
    try {
      const entry = JSON.parse(row);
      if (entry.type !== "assistant" || entry.isSidechain) continue;
      const written = entry.message?.usage?.cache_creation;
      if (written?.ephemeral_1h_input_tokens > 0) return "1h";
      if (written?.ephemeral_5m_input_tokens > 0) return "5m";
    } catch {
      // a row still being written
    }
  }
  // Unknown: a 5m cache found cold at the first refresh stops the mod anyway.
  return "1h";
};

const transcriptPath = async ($: EngineInterface) => {
  if (idle.transcriptPath !== undefined) return idle.transcriptPath;
  const home =
    (await $.env.get("USERPROFILE")) ?? (await $.env.get("HOME")) ?? "";
  const project = (await $.session.cwd()).replace(/[^a-zA-Z0-9]/g, "-");
  return `${home}/.claude/projects/${project}/${await $.session.id()}.jsonl`;
};

const readTier = async ($: EngineInterface): Promise<CacheTier> => {
  const path = await transcriptPath($);
  // A long transcript is past the 4 MiB that $.fs.read takes, so read its tail.
  try {
    const tail = await $.process.run([
      "tail",
      "-n",
      String(TIER_SCAN_ROWS),
      path,
    ]);
    if (tail.exitCode === 0) return cacheTier(tail.stdout);
  } catch {
    // no tail on PATH
  }
  try {
    return cacheTier(String(await $.fs.read(path)));
  } catch {
    return "1h";
  }
};

const ttlMs = () => config.ttlOverrideMs ?? TTL_MS[idle.tier];
const leadMs = () => Math.min(LEAD_MS[idle.tier], ttlMs() / 2);

const stop = ($: EngineInterface, why: string) => {
  idle.isStopped = true;
  $.ui.log(`cache-keepalive stopped after ${idle.refreshes} refreshes: ${why}`);
};

const refreshIfDue = async ($: EngineInterface, now: number) => {
  if (
    idle.isStopped ||
    idle.lastReadAt === undefined ||
    idle.lastTurnEndAt === undefined
  )
    return;
  if (now - idle.lastReadAt < ttlMs() - leadMs()) return;
  // Past the TTL (the machine slept) a refresh would re-cache the whole
  // transcript, which is what the person's next prompt does anyway.
  if (now - idle.lastReadAt >= ttlMs())
    return stop($, "the cache was already cold");
  if (now - idle.lastTurnEndAt >= config.maxIdleMs)
    return stop($, "the idle limit was reached");
  idle.isPinging = true;
  try {
    const reply = await $.model.fork({prompt: PING_PROMPT});
    if (!reply.isAnswered)
      return stop($, `the refresh failed (${reply.reason})`);
    if (reply.usage.cache_read_input_tokens < MIN_CACHE_READ_TOKENS) {
      return stop($, "the refresh found the cache cold");
    }
    idle.lastReadAt = now;
    idle.refreshes++;
    $.ui.log(
      `cache-keepalive refreshed the cache (${reply.usage.cache_read_input_tokens} tokens)`,
    );
  } finally {
    idle.isPinging = false;
  }
};

const poll = async ($: EngineInterface) => {
  const now = await $.clock.now();
  lastPollAt = now;
  if (idle.isInTurn || idle.isPinging || idle.isDisabled) return;
  await refreshIfDue($, now);
};

// Starts the poll, or starts it again when it has gone quiet: no session.start
// fires after /clear, so a turn is the next chance to notice.
const ensurePoller = async ($: EngineInterface) => {
  const now = await $.clock.now();
  if (poller !== undefined && now - lastPollAt < 3 * POLL_MS) return;
  poller?.cancel();
  lastPollAt = now;
  poller = $.clock.every(POLL_MS, () => void poll($));
};

const keepaliveCommand = (args: string) => {
  const word = args.trim().toLowerCase();
  if (word === "off") {
    idle.isDisabled = true;
    return "cache-keepalive is off for this session.";
  }
  if (word === "on") {
    idle.isDisabled = false;
    return "cache-keepalive is on from the next turn.";
  }
  const state = idle.isDisabled
    ? "off"
    : idle.isStopped
      ? "waiting for the next turn"
      : "keeping the cache warm";
  return `cache-keepalive: ${state}, ${idle.refreshes} refreshes this gap, ${idle.tier} tier. Usage: /keepalive off | on`;
};

export const register: Register = (on, options) => {
  config.maxIdleMs = hoursToMs(options.maxIdleHours, 3 * 60 * MINUTE_MS);

  on("session.start", async ($, e, next) => {
    const ttlMinutes = Number(await $.env.get("CACHE_KEEPALIVE_TTL_MIN"));
    config.ttlOverrideMs = ttlMinutes > 0 ? ttlMinutes * MINUTE_MS : undefined;
    await $.command.register({
      argumentHint: "off | on",
      description: "Cache keepalive: off, on, or show its state",
      name: "keepalive",
    });
    await ensurePoller($);
    return next(e);
  });

  on("command.run", {command: "keepalive"}, async (_$, e) => ({
    text: keepaliveCommand(e.args),
  }));

  // Turns raised while the refresh forks are the mod's own, never the person's.
  on("turn.start", (_$, e, next) => {
    if (e.agentId === undefined && !idle.isPinging) idle.isInTurn = true;
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    if (e.agentId === undefined && !idle.isPinging) {
      const now = await $.clock.now();
      idle.isInTurn = false;
      idle.lastTurnEndAt = now;
      idle.lastReadAt = now;
      idle.refreshes = 0;
      idle.isStopped = false;
      // The turn's own cache write may reach the transcript a moment later;
      // an older row of the same session carries the same tier.
      idle.tier = await readTier($);
      await ensurePoller($);
    }
    return next(e);
  });

  on("classic.Stop", (_$, e, next) => {
    idle.transcriptPath = e.transcript_path;
    return next(e);
  }).catch((_$, e, next) => next(e));
};
