import type { Replay } from "../core/types";

export type AgentProfile = "balanced" | "conservative" | "greedy";
export type BallStatus = "draft" | "deployed";
export type BallPattern = "solid" | "ring" | "spark";
export type BallSkillMode = "none" | "forage" | "evade" | "dash" | "hunt" | "edge" | "center" | "shadow";
export type BallEditActor = "user" | "agent";
export type BallEditType = "create" | "basic" | "agent-rules";

export interface PlatformUser {
  userId: string;
  displayName: string;
  createdAt: string;
}

export interface BallAppearance {
  color: string;
  accentColor: string;
  pattern: BallPattern;
}

export interface BallRecord {
  matches: number;
  wins: number;
  avgRank: number;
  bestRank: number | null;
  bestScore: number;
  lastRank: number | null;
  lastScore: number;
  totalKills: number;
  totalDeaths: number;
}

export interface PlatformBall {
  ballId: string;
  ownerId: string;
  ownerName: string;
  name: string;
  motto: string;
  appearance: BallAppearance;
  agentProfile: AgentProfile;
  agentProfileLabel: string;
  skill: BallSkillMode;
  skillName: string;
  skillRule: string;
  skillLabel: string;
  skillDescription: string;
  internalRevision: number;
  status: BallStatus;
  createdAt: string;
  updatedAt: string;
  deployedAt?: string;
  record: BallRecord;
}

export interface PlatformBattleResult {
  ballId: string;
  agentId: string;
  ownerId: string;
  ownerName: string;
  ballName: string;
  rank: number;
  score: number;
  alive: boolean;
  finalMass: number;
  kills: number;
  deaths: number;
  survivalTime: number;
  foodPickedMass: number;
  burstsTotal: number;
  burstsEffective: number;
}

export interface PlatformMatchRecord {
  matchId: string;
  seed: number;
  createdAt: string;
  durationSeconds: number;
  participantBallIds: string[];
  winnerBallId?: string;
  replayFile: string;
  results: PlatformBattleResult[];
}

export interface BallEditRecord {
  editId: string;
  ballId: string;
  ballName: string;
  ownerId: string;
  ownerName: string;
  actor: BallEditActor;
  type: BallEditType;
  summary: string;
  ruleText?: string;
  beforeProfile?: AgentProfile;
  afterProfile?: AgentProfile;
  createdAt: string;
}

export interface PlatformSnapshot {
  users: PlatformUser[];
  balls: PlatformBall[];
  matches: PlatformMatchRecord[];
  editRecords: BallEditRecord[];
  leaderboard: Array<{
    ballId: string;
    ballName: string;
    ownerName: string;
    score: number;
    matches: number;
    wins: number;
    avgRank: number;
  }>;
  deployedBallIds: string[];
  userLimits: {
    maxBallsPerUser: number;
  };
  sharePort: {
    label: string;
    method: string;
    fields: string[];
  };
  agentRules: {
    userCanEdit: string[];
    agentOnly: string[];
  };
  autoMatch: {
    minPlayers: number;
    cooldownSeconds: number;
    lastRunAt?: string;
  };
}

export interface PlatformRunResponse {
  snapshot: PlatformSnapshot;
  replay: Replay;
  match: PlatformMatchRecord;
}

export interface AuthUser {
  userId: string;
  email: string;
  displayName: string;
}

export interface AuthMeResponse {
  user: AuthUser | null;
}

export async function loadCurrentUser(): Promise<AuthUser | null> {
  const response = await requestJson<AuthMeResponse>("/api/auth/me");
  return response.user;
}

export async function requestLoginCode(email: string): Promise<{ ok: true; devCode?: string }> {
  return requestJson<{ ok: true; devCode?: string }>("/api/auth/request-code", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function verifyLoginCode(email: string, code: string): Promise<AuthUser> {
  const response = await requestJson<{ user: AuthUser }>("/api/auth/verify-code", {
    method: "POST",
    body: JSON.stringify({ email, code }),
  });
  return response.user;
}

export async function logoutCurrentUser(): Promise<void> {
  await requestJson<{ ok: true }>("/api/auth/logout", {
    method: "POST",
  });
}

export async function loadPlatformSnapshot(): Promise<PlatformSnapshot> {
  return requestJson<PlatformSnapshot>("/api/platform");
}

export async function createPlatformBall(input: {
  ownerId?: string;
  ownerName?: string;
  name?: string;
  motto?: string;
  appearance?: Partial<BallAppearance>;
}): Promise<PlatformSnapshot> {
  return requestJson<PlatformSnapshot>("/api/platform/balls", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function savePlatformAppearance(input: {
  ballId: string;
  name?: string;
  motto?: string;
  appearance?: Partial<BallAppearance>;
}): Promise<PlatformSnapshot> {
  return requestJson<PlatformSnapshot>("/api/platform/balls/appearance", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deletePlatformBall(ballId: string): Promise<PlatformSnapshot> {
  return requestJson<PlatformSnapshot>("/api/platform/balls", {
    method: "DELETE",
    body: JSON.stringify({ ballId }),
  });
}

export async function runPlatformMatch(input: { seed?: number; durationSeconds?: number; ballIds?: string[] }): Promise<PlatformRunResponse> {
  return requestJson<PlatformRunResponse>("/api/platform/matches", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function uploadAgentBallEdit(input: {
  ballId: string;
  editRule: string;
  profile?: AgentProfile;
  skill?: string;
  skillRule?: string;
}): Promise<PlatformSnapshot> {
  return requestJson<PlatformSnapshot>("/api/agent/ball-edit-upload", {
    method: "POST",
    body: JSON.stringify({ ...input, actor: "agent" }),
  });
}

export function agentIdForBall(ballId: string): string {
  return `agent_${ballId}`;
}

export function statusLabel(status: BallStatus): string {
  return status === "deployed" ? "已部署" : "草稿";
}

export function patternLabel(pattern: BallPattern): string {
  if (pattern === "ring") return "光环";
  if (pattern === "spark") return "星芒";
  return "纯色";
}

export function shortBallName(name: string): string {
  return name.length > 4 ? name.slice(0, 4) : name;
}

export function ownedBallCount(platform: PlatformSnapshot, ownerId: string): number {
  return platform.balls.filter((ball) => ball.ownerId === ownerId).length;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const raw = await response.text();
  let payload: (T & { error?: string }) | null = null;
  try {
    payload = raw ? JSON.parse(raw) as T & { error?: string } : null;
  } catch {
    throw new Error(`接口返回不是 JSON：${raw.slice(0, 80) || response.statusText}`);
  }
  if (!response.ok) {
    throw new Error(payload?.error ?? "接口调用失败");
  }
  if (!payload) throw new Error("接口返回为空");
  return payload;
}
