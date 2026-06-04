import { runNextPlatformEventRoundInState } from "../core/platform.js";
import { mutatePlatformState, savePlatformReplayToStore } from "../core/platform-storage.js";

const roundSleepSeconds = positiveEnv("AGENTBALL_EVENT_ROUND_SECONDS", 60);
const idleSleepSeconds = positiveEnv("AGENTBALL_EVENT_IDLE_SECONDS", 10);
const eventEndpoint = process.env.AGENTBALL_EVENT_ENDPOINT;
const cronSecret = process.env.CRON_SECRET;

console.log([
  "[event-worker] started.",
  `mode=${eventEndpoint ? "endpoint" : "direct"}`,
  `round=${roundSleepSeconds}s`,
  `idle=${idleSleepSeconds}s`,
].join(" "));

while (true) {
  try {
    const ran = eventEndpoint ? await runEndpointRound(eventEndpoint) : await runDirectRound();
    await sleep((ran ? roundSleepSeconds : idleSleepSeconds) * 1000);
  } catch (error) {
    console.error("[event-worker] error", error instanceof Error ? error.message : String(error));
    await sleep(idleSleepSeconds * 1000);
  }
}

async function runDirectRound(): Promise<boolean> {
  const result = await mutatePlatformState((state) => runNextPlatformEventRoundInState(state, new Date()));
  if (!result) return false;
  await savePlatformReplayToStore(result.replay);
  console.log([
    "[event-worker] round",
    result.match.roundIndex ?? "?",
    result.match.matchId,
    `winner=${result.match.winnerBallId ?? "none"}`,
    `participants=${result.match.results.length}`,
  ].join(" "));
  return true;
}

async function runEndpointRound(endpoint: string): Promise<boolean> {
  if (!cronSecret) throw new Error("endpoint 模式缺少 CRON_SECRET");
  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${cronSecret}`,
    },
  });
  const payload = await response.json().catch(() => ({})) as {
    ran?: boolean;
    matchId?: string;
    roundIndex?: number;
    participantCount?: number;
    winnerBallId?: string;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error ?? `endpoint returned ${response.status}`);
  }
  if (!payload.ran) return false;
  console.log([
    "[event-worker] round",
    payload.roundIndex ?? "?",
    payload.matchId ?? "?",
    `winner=${payload.winnerBallId ?? "none"}`,
    `participants=${payload.participantCount ?? "?"}`,
  ].join(" "));
  return true;
}

function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
