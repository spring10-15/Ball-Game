import type { Event, Replay, ReplayFrame } from "../core/types";
import { runMatch } from "../core/simulator";
import balanced from "../core/starter-balanced";
import conservative from "../core/starter-conservative";
import greedy from "../core/starter-greedy";

export interface EvalSummary {
  args: {
    matches: number;
    duration: number;
    seedStart: number;
  };
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
    results: Array<{
      agentId: string;
      name: string;
      rank: number;
      score: number;
      alive: boolean;
    }>;
  }>;
}

export const agentColors = [
  "#2563eb",
  "#0891b2",
  "#16a34a",
  "#d97706",
  "#dc2626",
  "#7c3aed",
  "#db2777",
  "#475569",
];

export async function loadReplay(): Promise<Replay> {
  try {
    const response = await fetch("/last-replay.json");
    const replay = await readJsonOrNull<Replay>(response);
    if (replay) return replay;
  } catch {
    // 线上可能没有静态回放文件，继续使用内置回放兜底。
  }
  try {
    const fallback = await fetch("/api/replay/demo");
    const replay = await readJsonOrNull<Replay>(fallback);
    if (replay) return replay;
  } catch {
    // API 不可用时，浏览器端直接生成一份默认回放。
  }
  return createFallbackReplay();
}

export async function loadEvalSummary(): Promise<EvalSummary | null> {
  try {
    const response = await fetch("/eval-summary.json");
    if (response.status === 404) return null;
    return await readJsonOrNull<EvalSummary>(response);
  } catch {
    return null;
  }
}

export async function runLocalSimulation(options: { seed?: number; durationSeconds?: number }): Promise<Replay> {
  const response = await fetch("/api/run-sim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  const payload = (await response.json()) as { replay?: Replay; error?: string };
  if (!response.ok || !payload.replay) {
    throw new Error(payload.error ?? `单局模拟失败：${response.status}`);
  }
  return payload.replay;
}

export async function runLocalEvaluation(options: {
  matches?: number;
  duration?: number;
  seedStart?: number;
}): Promise<EvalSummary> {
  const response = await fetch("/api/run-eval", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  const payload = (await response.json()) as { summary?: EvalSummary; error?: string };
  if (!response.ok || !payload.summary) {
    throw new Error(payload.error ?? `多局评测失败：${response.status}`);
  }
  return payload.summary;
}

export function getAgentColor(replay: Replay, agentId: string): string {
  const ids = replay.results.map((result) => result.agentId);
  const index = Math.max(0, ids.indexOf(agentId));
  return agentColors[index % agentColors.length];
}

export function displayAgentName(agentIdOrName: string): string {
  const normalized = agentIdOrName.toLowerCase();
  if (normalized.includes("balanced")) return "均衡型";
  if (normalized.includes("cons_1") || normalized.includes("conservative-1")) return "稳健一号";
  if (normalized.includes("cons_2") || normalized.includes("conservative-2")) return "稳健二号";
  if (normalized.includes("greedy_1") || normalized.includes("greedy-1")) return "猛冲一号";
  if (normalized.includes("greedy_2") || normalized.includes("greedy-2")) return "猛冲二号";
  if (/[\u4e00-\u9fa5]/.test(agentIdOrName)) return agentIdOrName;
  return "未知智能体";
}

export function displayAgentShortName(agentIdOrName: string): string {
  const name = displayAgentName(agentIdOrName).replace("一号", "一").replace("二号", "二");
  return name.length > 4 ? name.slice(0, 4) : name;
}

export function displayMatchName(matchId: string, seed: number): string {
  const suffix = matchId.match(/(\d+)$/)?.[1] ?? String(seed);
  return `第 ${suffix} 局`;
}

export function displayEndReason(reason: string | undefined): string {
  if (reason === "timeout") return "时间结束";
  if (reason === "last-standing") return "最后存活";
  if (reason === "all-dead") return "全部出局";
  return "进行中";
}

export function displayEventType(type: Event["type"] | "all"): string {
  switch (type) {
    case "all":
      return "全部";
    case "spawn":
      return "出生";
    case "death":
      return "出局";
    case "kill":
      return "吞噬";
    case "burst":
      return "冲刺";
    case "burst-saved":
      return "脱险";
    case "danger-enter":
      return "遇险";
    case "danger-exit":
      return "脱离";
    case "food-pickup":
      return "进食";
    case "decision-error":
      return "决策错误";
    case "game-end":
      return "结束";
  }
}

export function frameAt(replay: Replay, index: number): ReplayFrame {
  return replay.frames[Math.max(0, Math.min(replay.frames.length - 1, index))];
}

export function eventsUntil(replay: Replay, frame: ReplayFrame): Event[] {
  return replay.events.filter((event) => event.time <= frame.time);
}

export function eventLabel(event: Event, nameOf: (agentId: string) => string = displayAgentName): string {
  switch (event.type) {
    case "spawn":
      return `${nameOf(event.agentId)} 出生`;
    case "death":
      return `${nameOf(event.agentId)} 出局`;
    case "kill":
      return `${nameOf(event.killerAgentId)} 吞掉 ${nameOf(event.victimAgentId)}`;
    case "burst":
      return `${nameOf(event.agentId)} 发起冲刺`;
    case "burst-saved":
      return `${nameOf(event.agentId)} 靠冲刺脱险`;
    case "danger-enter":
      return `${nameOf(event.agentId)} 进入危险距离`;
    case "danger-exit":
      return `${nameOf(event.agentId)} 脱离危险距离`;
    case "food-pickup":
      return `${nameOf(event.agentId)} 吃到 ${event.mass} 质量`;
    case "decision-error":
      return `${nameOf(event.agentId)} 出现无效决策`;
    case "game-end":
      return `比赛结束：${displayEndReason(event.reason)}`;
  }
}

export function eventTone(type: Event["type"]): "neutral" | "good" | "bad" | "warn" {
  if (type === "kill" || type === "burst-saved" || type === "food-pickup") return "good";
  if (type === "death" || type === "decision-error") return "bad";
  if (type === "danger-enter" || type === "burst") return "warn";
  return "neutral";
}

export function formatTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const mm = Math.floor(whole / 60);
  const ss = whole % 60;
  return `${mm}:${ss.toString().padStart(2, "0")}`;
}

export function formatNumber(value: number, fractionDigits = 0): string {
  return value.toLocaleString("en-US", {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: fractionDigits,
  });
}

function isJsonResponse(response: Response): boolean {
  return response.ok && (response.headers.get("content-type") ?? "").includes("application/json");
}

async function readJsonOrNull<T>(response: Response): Promise<T | null> {
  if (!isJsonResponse(response)) return null;
  const raw = await response.text();
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function createFallbackReplay(): Replay {
  return runMatch({
    matchId: "demo_42",
    config: { seed: 42, durationSeconds: 60 },
    agents: [
      { agentId: "a_balanced", name: "Balanced", strategy: balanced },
      { agentId: "a_cons_1", name: "Conservative-1", strategy: conservative },
      { agentId: "a_cons_2", name: "Conservative-2", strategy: conservative },
      { agentId: "a_greedy_1", name: "Greedy-1", strategy: greedy },
      { agentId: "a_greedy_2", name: "Greedy-2", strategy: greedy },
    ],
  });
}
