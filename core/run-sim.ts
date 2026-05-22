/**
 * 本地 runner：跑一局并写出 replay。
 *
 * 输出：
 *   ./out/last-replay.json
 *   ./out/last-events.json
 *   ./out/last-metrics.json
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { AgentEntry, Replay } from "./types.js";
import { runMatch } from "./simulator.js";
import balanced from "./starter-balanced.js";
import conservative from "./starter-conservative.js";
import greedy from "./starter-greedy.js";

export interface DemoRunOptions {
  seed?: number;
  durationSeconds?: number;
  matchId?: string;
}

export const demoAgents: AgentEntry[] = [
  { agentId: "a_balanced", name: "Balanced", strategy: balanced },
  { agentId: "a_cons_1", name: "Conservative-1", strategy: conservative },
  { agentId: "a_cons_2", name: "Conservative-2", strategy: conservative },
  { agentId: "a_greedy_1", name: "Greedy-1", strategy: greedy },
  { agentId: "a_greedy_2", name: "Greedy-2", strategy: greedy },
];

export function runDemoMatch(options: DemoRunOptions = {}): Replay {
  const seed = options.seed ?? 42;
  return runMatch({
    matchId: options.matchId ?? `demo_${seed}`,
    config: { seed, durationSeconds: options.durationSeconds ?? 60 },
    agents: demoAgents,
  });
}

export function writeReplayOutputs(replay: Replay, outDir = defaultOutDir()): {
  replayPath: string;
  eventsPath: string;
  metricsPath: string;
} {
  mkdirSync(outDir, { recursive: true });
  const replayPath = path.join(outDir, "last-replay.json");
  const eventsPath = path.join(outDir, "last-events.json");
  const metricsPath = path.join(outDir, "last-metrics.json");
  writeFileSync(replayPath, JSON.stringify(replay));
  writeFileSync(eventsPath, JSON.stringify(replay.events, null, 2));
  writeFileSync(
    metricsPath,
    JSON.stringify(replay.results.map((r) => ({ name: r.name, ...r.metrics })), null, 2),
  );
  return { replayPath, eventsPath, metricsPath };
}

export function runDemoAndWrite(options: DemoRunOptions = {}, outDir = defaultOutDir()) {
  const replay = runDemoMatch(options);
  const paths = writeReplayOutputs(replay, outDir);
  return { replay, paths };
}

function defaultOutDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "out");
}

function printReplaySummary(replay: Replay, paths: ReturnType<typeof writeReplayOutputs>) {
  console.log("\n=== Match result ===");
  console.log(`matchId: ${replay.matchId}`);
  console.log(`seed:    ${replay.seed}`);
  console.log(`frames:  ${replay.frames.length}`);
  console.log(`events:  ${replay.events.length}`);
  const endEvent = replay.events.find((e) => e.type === "game-end");
  console.log(`end:     ${endEvent ? `${endEvent.type === "game-end" ? endEvent.reason : ""} @ ${endEvent.time.toFixed(2)}s` : "n/a"}`);

  console.log("\n名次  |  agent          |  score   |  mass  |  kills  |  bursts(eff/tot)  |  lives left  |  errors");
  console.log("------+-----------------+----------+--------+---------+-------------------+--------------+--------");
  for (const r of replay.results) {
    const m = r.metrics;
    const revivesLeft = replay.config.revive.maxLives - r.livesUsed;
    console.log(
      `  ${String(r.rank).padStart(2)}  | ` +
        `${r.name.padEnd(15)} | ` +
        `${m.score.toFixed(0).padStart(7)} | ` +
        `${m.finalMass.toFixed(0).padStart(6)} | ` +
        `${String(m.kills).padStart(6)}  | ` +
        `   ${m.burstsEffective}/${m.burstsTotal}`.padEnd(18) + " | " +
        `      ${revivesLeft}        | ` +
        `${m.decisionErrors}`,
    );
  }

  console.log(`\nReplay 写入: ${path.relative(process.cwd(), paths.replayPath)}`);
  console.log(`Events 写入: ${path.relative(process.cwd(), paths.eventsPath)}`);
}

function main() {
  const result = runDemoAndWrite();
  printReplaySummary(result.replay, result.paths);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
