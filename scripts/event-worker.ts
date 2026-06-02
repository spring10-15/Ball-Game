import { runNextPlatformEventRoundInState } from "../core/platform.js";
import { mutatePlatformState, savePlatformReplayToStore } from "../core/platform-storage.js";

const roundSleepSeconds = positiveEnv("AGENTBALL_EVENT_ROUND_SECONDS", 60);
const idleSleepSeconds = positiveEnv("AGENTBALL_EVENT_IDLE_SECONDS", 10);

console.log(`[event-worker] started. round=${roundSleepSeconds}s idle=${idleSleepSeconds}s`);

while (true) {
  const result = await mutatePlatformState((state) => runNextPlatformEventRoundInState(state, new Date()));
  if (result) {
    await savePlatformReplayToStore(result.replay);
    console.log([
      "[event-worker] round",
      result.match.roundIndex ?? "?",
      result.match.matchId,
      `winner=${result.match.winnerBallId ?? "none"}`,
      `participants=${result.match.results.length}`,
    ].join(" "));
    await sleep(roundSleepSeconds * 1000);
  } else {
    await sleep(idleSleepSeconds * 1000);
  }
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
