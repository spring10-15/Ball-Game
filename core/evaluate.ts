/**
 * 多局评测 runner。
 *
 * 用法：
 *   npm run eval -- --matches 30 --duration 60
 *
 * 输出：
 *   ./out/eval-summary.json
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { AgentEntry, MatchMetrics, MatchResult } from "./types.js";
import { runMatch } from "./simulator.js";
import balanced from "./starter-balanced.js";
import conservative from "./starter-conservative.js";
import greedy from "./starter-greedy.js";

export interface EvalArgs {
  matches: number;
  duration: number;
  seedStart: number;
}

interface Aggregate {
  name: string;
  agentId: string;
  matches: number;
  rankSum: number;
  wins: number;
  scoreSum: number;
  massSum: number;
  killSum: number;
  deathSum: number;
  survivalSum: number;
  foodSum: number;
  burstTotal: number;
  burstEffective: number;
  dangerSum: number;
  errorSum: number;
}

export interface EvaluationSummary {
  args: EvalArgs;
  summary: Array<{
    agentId: string;
    name: string;
    matches: number;
    winRate: number;
    avgRank: number;
    avgScore: number;
    avgFinalMass: number;
    avgKills: number;
    avgDeaths: number;
    avgSurvival: number;
    avgFoodMass: number;
    burstEfficiency: number;
    avgDangerSeconds: number;
    decisionErrors: number;
  }>;
  matches: Array<{
    matchId: string;
    seed: number;
    winner: string;
    results: Array<Pick<MatchResult, "agentId" | "name" | "rank" | "score" | "alive">>;
  }>;
}

export const evaluationAgents: AgentEntry[] = [
  { agentId: "a_balanced", name: "Balanced", strategy: balanced },
  { agentId: "a_cons_1", name: "Conservative-1", strategy: conservative },
  { agentId: "a_cons_2", name: "Conservative-2", strategy: conservative },
  { agentId: "a_greedy_1", name: "Greedy-1", strategy: greedy },
  { agentId: "a_greedy_2", name: "Greedy-2", strategy: greedy },
];

export function runEvaluation(args: EvalArgs): EvaluationSummary {
  const aggregates = new Map<string, Aggregate>();
  const matchSummaries: EvaluationSummary["matches"] = [];

  for (let i = 0; i < args.matches; i++) {
    const seed = args.seedStart + i;
    const replay = runMatch({
      matchId: `eval_${seed}`,
      config: { seed, durationSeconds: args.duration },
      agents: evaluationAgents,
    });

    matchSummaries.push({
      matchId: replay.matchId,
      seed,
      winner: replay.results[0]?.name ?? "n/a",
      results: replay.results.map((r) => ({
        agentId: r.agentId,
        name: r.name,
        rank: r.rank,
        score: round(r.score),
        alive: r.alive,
      })),
    });

    for (const result of replay.results) {
      addResult(aggregates, result);
    }
  }

  const summary = [...aggregates.values()]
    .map((a) => ({
      agentId: a.agentId,
      name: a.name,
      matches: a.matches,
      winRate: round(a.wins / a.matches),
      avgRank: round(a.rankSum / a.matches),
      avgScore: round(a.scoreSum / a.matches),
      avgFinalMass: round(a.massSum / a.matches),
      avgKills: round(a.killSum / a.matches),
      avgDeaths: round(a.deathSum / a.matches),
      avgSurvival: round(a.survivalSum / a.matches),
      avgFoodMass: round(a.foodSum / a.matches),
      burstEfficiency: a.burstTotal === 0 ? 0 : round(a.burstEffective / a.burstTotal),
      avgDangerSeconds: round(a.dangerSum / a.matches),
      decisionErrors: a.errorSum,
    }))
    .sort((a, b) => a.avgRank - b.avgRank || b.avgScore - a.avgScore);

  return {
    args,
    summary,
    matches: matchSummaries,
  };
}

export function writeEvaluation(summary: EvaluationSummary, outDir = defaultOutDir()): string {
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "eval-summary.json");
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  return outPath;
}

function addResult(aggregates: Map<string, Aggregate>, result: MatchResult) {
  const metrics: MatchMetrics = result.metrics;
  let aggregate = aggregates.get(result.agentId);
  if (!aggregate) {
    aggregate = {
      name: result.name,
      agentId: result.agentId,
      matches: 0,
      rankSum: 0,
      wins: 0,
      scoreSum: 0,
      massSum: 0,
      killSum: 0,
      deathSum: 0,
      survivalSum: 0,
      foodSum: 0,
      burstTotal: 0,
      burstEffective: 0,
      dangerSum: 0,
      errorSum: 0,
    };
    aggregates.set(result.agentId, aggregate);
  }

  aggregate.matches++;
  aggregate.rankSum += result.rank;
  aggregate.wins += result.rank === 1 ? 1 : 0;
  aggregate.scoreSum += metrics.score;
  aggregate.massSum += metrics.finalMass;
  aggregate.killSum += metrics.kills;
  aggregate.deathSum += metrics.deaths;
  aggregate.survivalSum += metrics.survivalTime;
  aggregate.foodSum += metrics.foodPickedMass;
  aggregate.burstTotal += metrics.burstsTotal;
  aggregate.burstEffective += metrics.burstsEffective;
  aggregate.dangerSum += metrics.dangerSeconds;
  aggregate.errorSum += metrics.decisionErrors;
}

function printSummary(summary: EvaluationSummary["summary"], args: EvalArgs, outPath: string) {
  console.log(`\n=== Eval summary (${args.matches} matches, ${args.duration}s, seeds ${args.seedStart}-${args.seedStart + args.matches - 1}) ===`);
  console.log("agent          | win%  | avgRank | avgScore | avgMass | kills | deaths | food  | burstEff | danger | errors");
  console.log("---------------+-------+---------+----------+---------+-------+--------+-------+----------+--------+-------");
  for (const row of summary) {
    console.log(
      `${row.name.padEnd(14)} | ` +
        `${(row.winRate * 100).toFixed(0).padStart(4)}% | ` +
        `${row.avgRank.toFixed(2).padStart(7)} | ` +
        `${row.avgScore.toFixed(0).padStart(8)} | ` +
        `${row.avgFinalMass.toFixed(0).padStart(7)} | ` +
        `${row.avgKills.toFixed(2).padStart(5)} | ` +
        `${row.avgDeaths.toFixed(2).padStart(6)} | ` +
        `${row.avgFoodMass.toFixed(0).padStart(5)} | ` +
        `${(row.burstEfficiency * 100).toFixed(0).padStart(7)}% | ` +
        `${row.avgDangerSeconds.toFixed(1).padStart(6)} | ` +
        `${String(row.decisionErrors).padStart(5)}`,
    );
  }
  console.log(`\nSummary 写入: ${path.relative(process.cwd(), outPath)}`);
}

function parseArgs(argv: string[]): EvalArgs {
  const args: EvalArgs = { matches: 30, duration: 60, seedStart: 1000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--matches" && next) {
      args.matches = positiveInt(next, "matches");
      i++;
    } else if (arg === "--duration" && next) {
      args.duration = positiveInt(next, "duration");
      i++;
    } else if (arg === "--seed-start" && next) {
      args.seedStart = positiveInt(next, "seed-start");
      i++;
    }
  }
  return args;
}

function positiveInt(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

function defaultOutDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "out");
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const summary = runEvaluation(args);
  const outPath = writeEvaluation(summary);
  printSummary(summary.summary, args, outPath);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
