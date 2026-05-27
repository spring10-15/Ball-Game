/**
 * 本地开放平台层。
 *
 * 这里负责用户、球球、对局记录、编辑记录与 Agent 托管策略的编排。
 * 用户开放接口只能创建、查看、改名字与外观；内部策略档位只能通过 Agent 上传端口调整。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentEntry, EnemyView, MatchResult, Pos, Replay, SelfView, StrategyFn, WorldView } from "./types.js";
import { runMatch } from "./simulator.js";
import balanced from "./starter-balanced.js";
import conservative from "./starter-conservative.js";
import greedy from "./starter-greedy.js";

export type AgentProfile = "balanced" | "conservative" | "greedy";
export type BallStatus = "draft" | "deployed";
export type BallPattern = "solid" | "ring" | "spark";
export type BallSkillMode = "none" | "forage" | "evade" | "dash" | "hunt" | "edge" | "center" | "shadow";
export type BallEditActor = "user" | "agent";
export type BallEditType = "create" | "basic" | "agent-rules";

export const MAX_BALLS_PER_USER = 3;

export interface PlatformUser {
  userId: string;
  displayName: string;
  createdAt: string;
  email?: string;
  emailHash?: string;
  lastLoginAt?: string;
}

export interface AuthCodeRecord {
  email: string;
  emailHash: string;
  codeHash: string;
  attempts: number;
  createdAt: string;
  expiresAt: string;
}

export interface AuthSessionRecord {
  sessionId: string;
  userId: string;
  email: string;
  emailHash: string;
  createdAt: string;
  expiresAt: string;
}

export interface BallAppearance {
  color: string;
  accentColor: string;
  pattern: BallPattern;
}

export interface PlatformBall {
  ballId: string;
  ownerId: string;
  name: string;
  motto: string;
  appearance: BallAppearance;
  agentProfile: AgentProfile;
  skill: BallSkillMode;
  skillName: string;
  skillRule: string;
  internalRevision: number;
  status: BallStatus;
  createdAt: string;
  updatedAt: string;
  deployedAt?: string;
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

export interface PlatformState {
  schemaVersion: 1;
  users: PlatformUser[];
  balls: PlatformBall[];
  matches: PlatformMatchRecord[];
  editRecords: BallEditRecord[];
  authCodes?: AuthCodeRecord[];
  authSessions?: AuthSessionRecord[];
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

export interface PlatformSnapshot {
  users: PlatformUser[];
  balls: Array<PlatformBall & {
    ownerName: string;
    record: BallRecord;
    agentProfileLabel: string;
    skillLabel: string;
    skillDescription: string;
  }>;
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
}

export interface CreateUserBallInput {
  ownerId?: string;
  ownerName?: string;
  name?: string;
  motto?: string;
  appearance?: Partial<BallAppearance>;
}

export interface UpdateAppearanceInput {
  ballId: string;
  name?: string;
  motto?: string;
  appearance?: Partial<BallAppearance>;
}

export interface RunPlatformBattleInput {
  seed?: number;
  durationSeconds?: number;
  ballIds?: string[];
}

export interface AgentTuneInput {
  ballId: string;
  profile?: AgentProfile;
  skill?: string;
  skillRule?: string;
  editRule?: string;
  actor?: string;
}

const profileLabels: Record<AgentProfile, string> = {
  balanced: "均衡托管",
  conservative: "稳健托管",
  greedy: "进攻托管",
};

const skillLabels: Record<BallSkillMode, string> = {
  none: "无专属技能",
  forage: "觅食直觉",
  evade: "避险本能",
  dash: "短冲调校",
  hunt: "猎手机会",
  edge: "贴边求生",
  center: "中心控场",
  shadow: "影子绕行",
};

const skillDescriptions: Record<BallSkillMode, string> = {
  none: "不启用额外技能，只按托管档位行动。",
  forage: "安全时更优先抢中大型营养块，不改变质量收益。",
  evade: "更早识别大球威胁，必要时用已有冲刺逃离。",
  dash: "只在明确追击或逃生窗口使用冲刺，不缩短冷却。",
  hunt: "发现明显可吞噬目标时主动追击，避免追无敌或过近大球。",
  edge: "低质量、低复活或被压迫时优先贴边转移，降低被夹击概率。",
  center: "安全窗口内向中心高资源区控场，危险出现后交还托管策略。",
  shadow: "围绕大球安全半径外侧游走，抢附近资源但不硬碰。",
};

const strategyByProfile: Record<AgentProfile, StrategyFn> = {
  balanced,
  conservative,
  greedy,
};

const defaultAppearance: BallAppearance = {
  color: "#2563eb",
  accentColor: "#f8fafc",
  pattern: "ring",
};

export function loadPlatformState(outDir = defaultOutDir()): PlatformState {
  const file = stateFile(outDir);
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as PlatformState;
    if (parsed.schemaVersion === 1) {
      const state = normalizeState(parsed);
      if (state !== parsed) savePlatformState(state, outDir);
      return state;
    }
  } catch {
    // 首次启动时生成示例数据。
  }
  const state = makeInitialState();
  savePlatformState(state, outDir);
  return state;
}

export function savePlatformState(state: PlatformState, outDir = defaultOutDir()) {
  mkdirSync(path.dirname(stateFile(outDir)), { recursive: true });
  writeFileSync(stateFile(outDir), JSON.stringify(state, null, 2));
}

export function getPlatformSnapshot(outDir = defaultOutDir()): PlatformSnapshot {
  const state = loadPlatformState(outDir);
  return snapshotFromPlatformState(state);
}

export function createUserBall(input: CreateUserBallInput, outDir = defaultOutDir()): PlatformSnapshot {
  const state = loadPlatformState(outDir);
  const snapshot = createUserBallInState(state, input);
  savePlatformState(state, outDir);
  return snapshot;
}

export function updateBallAppearance(input: UpdateAppearanceInput, outDir = defaultOutDir()): PlatformSnapshot {
  const state = loadPlatformState(outDir);
  const snapshot = updateBallAppearanceInState(state, input);
  savePlatformState(state, outDir);
  return snapshot;
}

export function deleteUserBall(ballId: string, outDir = defaultOutDir()): PlatformSnapshot {
  const state = loadPlatformState(outDir);
  const snapshot = deleteUserBallInState(state, ballId);
  savePlatformState(state, outDir);
  return snapshot;
}

export function deployBall(ballId: string, outDir = defaultOutDir()): PlatformSnapshot {
  const state = loadPlatformState(outDir);
  const ball = mustFindBall(state, ballId);
  const now = new Date().toISOString();
  ball.status = "deployed";
  ball.deployedAt = now;
  ball.updatedAt = now;
  savePlatformState(state, outDir);
  return snapshotFromPlatformState(state);
}

export function undeployBall(ballId: string, outDir = defaultOutDir()): PlatformSnapshot {
  const state = loadPlatformState(outDir);
  const ball = mustFindBall(state, ballId);
  ball.status = "draft";
  ball.updatedAt = new Date().toISOString();
  savePlatformState(state, outDir);
  return snapshotFromPlatformState(state);
}

export function agentTuneBall(input: AgentTuneInput, outDir = defaultOutDir()): PlatformSnapshot {
  const state = loadPlatformState(outDir);
  const snapshot = agentTuneBallInState(state, input);
  savePlatformState(state, outDir);
  return snapshot;
}

export function runPlatformBattle(
  input: RunPlatformBattleInput,
  outDir = defaultOutDir(),
): { snapshot: PlatformSnapshot; replay: Replay; match: PlatformMatchRecord; paths: { replayPath: string; eventsPath: string; metricsPath: string } } {
  const state = loadPlatformState(outDir);
  const result = runPlatformBattleInState(state, input);
  savePlatformState(state, outDir);
  const paths = writePlatformReplay(result.replay, outDir);
  return { ...result, paths };
}

export function createInitialPlatformState(): PlatformState {
  return makeInitialState();
}

export function normalizePlatformState(state: PlatformState): PlatformState {
  return normalizeState(state);
}

export function snapshotFromPlatformState(state: PlatformState): PlatformSnapshot {
  return snapshotFromState(state);
}

export function createUserBallInState(state: PlatformState, input: CreateUserBallInput): PlatformSnapshot {
  const now = new Date().toISOString();
  const owner = findOrCreateUser(state, input.ownerId, input.ownerName, now);
  const ownedCount = state.balls.filter((ball) => ball.ownerId === owner.userId).length;
  if (ownedCount >= MAX_BALLS_PER_USER) {
    throw new Error(`每个用户最多只能创建 ${MAX_BALLS_PER_USER} 个球球`);
  }
  const ball: PlatformBall = {
    ballId: makeId("ball"),
    ownerId: owner.userId,
    name: cleanText(input.name, "新球球", 18),
    motto: cleanText(input.motto, "先活下来，再变大。", 36),
    appearance: normalizeAppearance(input.appearance),
    agentProfile: "balanced",
    skill: "none",
    skillName: "无专属技能",
    skillRule: "不启用额外技能，只按托管档位行动。",
    internalRevision: 1,
    status: "deployed",
    createdAt: now,
    updatedAt: now,
    deployedAt: now,
  };
  state.balls.unshift(ball);
  state.editRecords.unshift(makeEditRecord(state, ball, "user", "create", "用户创建球球"));
  return snapshotFromPlatformState(state);
}

export function upsertEmailUserInState(state: PlatformState, email: string, now = new Date().toISOString()): PlatformUser {
  const normalizedEmail = normalizeEmail(email);
  const emailHash = hashEmail(normalizedEmail);
  const userId = `user_${emailHash.slice(0, 20)}`;
  const displayName = cleanText(normalizedEmail.split("@")[0], "新用户", 12);
  const existing = state.users.find((user) => user.emailHash === emailHash || user.userId === userId);
  if (existing) {
    existing.email = normalizedEmail;
    existing.emailHash = emailHash;
    existing.lastLoginAt = now;
    if (!existing.displayName || existing.displayName === "新用户") existing.displayName = displayName;
    return existing;
  }
  const user: PlatformUser = {
    userId,
    displayName,
    email: normalizedEmail,
    emailHash,
    createdAt: now,
    lastLoginAt: now,
  };
  state.users.unshift(user);
  return user;
}

export function updateBallAppearanceInState(state: PlatformState, input: UpdateAppearanceInput): PlatformSnapshot {
  const ball = mustFindBall(state, input.ballId);
  ball.name = cleanText(input.name, ball.name, 18);
  ball.motto = cleanText(input.motto, ball.motto, 36);
  ball.appearance = normalizeAppearance(input.appearance, ball.appearance);
  ball.updatedAt = new Date().toISOString();
  state.editRecords.unshift(makeEditRecord(state, ball, "user", "basic", "用户修改名称或样式"));
  state.editRecords = state.editRecords.slice(0, 200);
  return snapshotFromPlatformState(state);
}

export function deleteUserBallInState(state: PlatformState, ballId: string): PlatformSnapshot {
  mustFindBall(state, ballId);
  state.balls = state.balls.filter((ball) => ball.ballId !== ballId);
  state.editRecords = state.editRecords.filter((record) => record.ballId !== ballId);
  state.matches = state.matches
    .map((match) => ({
      ...match,
      participantBallIds: match.participantBallIds.filter((id) => id !== ballId),
      winnerBallId: match.winnerBallId === ballId ? undefined : match.winnerBallId,
      results: match.results.filter((result) => result.ballId !== ballId),
    }))
    .filter((match) => match.results.length >= 2);
  return snapshotFromPlatformState(state);
}

export function agentTuneBallInState(state: PlatformState, input: AgentTuneInput): PlatformSnapshot {
  const ball = mustFindBall(state, input.ballId);
  const nextProfile = input.profile ?? inferProfileFromRule(input.editRule);
  const nextSkill = normalizeSkillInput(ball, input);
  if (!isAgentProfile(nextProfile)) throw new Error("未知的智能体托管档位");
  const beforeProfile = ball.agentProfile;
  ball.agentProfile = nextProfile;
  ball.skill = nextSkill.mode;
  ball.skillName = nextSkill.name;
  ball.skillRule = nextSkill.rule;
  ball.internalRevision += 1;
  ball.updatedAt = new Date().toISOString();
  state.editRecords.unshift(makeEditRecord(
    state,
    ball,
    "agent",
    "agent-rules",
    `智能体按编辑规则调整为${profileLabels[nextProfile]}，技能为${nextSkill.name}`,
    input.editRule,
    beforeProfile,
    nextProfile,
  ));
  state.editRecords = state.editRecords.slice(0, 200);
  return snapshotFromPlatformState(state);
}

export function runPlatformBattleInState(
  state: PlatformState,
  input: RunPlatformBattleInput,
): { snapshot: PlatformSnapshot; replay: Replay; match: PlatformMatchRecord } {
  const selectedBalls = selectBattleBalls(state, input.ballIds);
  if (selectedBalls.length < 2) {
    throw new Error("至少需要两个已部署球球才能开局");
  }

  const seed = positiveInt(input.seed, Math.floor(Date.now() % 100000));
  const durationSeconds = positiveInt(input.durationSeconds, 60);
  const agents = selectedBalls.map(agentEntryForBall);
  const matchId = `platform_${seed}_${Date.now().toString(36)}`;
  const replay = runMatch({
    matchId,
    config: { seed, durationSeconds },
    agents,
  });
  const match = buildMatchRecord(replay, selectedBalls, state.users, seed, durationSeconds);
  state.matches.unshift(match);
  state.matches = state.matches.slice(0, 80);
  return { snapshot: snapshotFromPlatformState(state), replay, match };
}

function makeInitialState(): PlatformState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    users: [
      { userId: "u_ling", displayName: "林舟", createdAt: now },
      { userId: "u_yun", displayName: "云栖", createdAt: now },
      { userId: "u_qi", displayName: "齐墨", createdAt: now },
    ],
    balls: [
      makeSeedBall("ball_ling_01", "u_ling", "青锋球", "稳稳变大，少犯错。", "#2563eb", "#dbeafe", "ring", "balanced", now),
      makeSeedBall("ball_yun_01", "u_yun", "橙焰球", "机会来了就冲。", "#ea580c", "#ffedd5", "spark", "greedy", now),
      makeSeedBall("ball_qi_01", "u_qi", "墨盾球", "保命就是输出。", "#0f766e", "#ccfbf1", "solid", "conservative", now),
    ],
    matches: [],
    editRecords: [],
  };
}

function makeSeedBall(
  ballId: string,
  ownerId: string,
  name: string,
  motto: string,
  color: string,
  accentColor: string,
  pattern: BallPattern,
  profile: AgentProfile,
  now: string,
  skill: BallSkillMode = "none",
): PlatformBall {
  return {
    ballId,
    ownerId,
    name,
    motto,
    appearance: { color, accentColor, pattern },
    agentProfile: profile,
    skill,
    skillName: skillLabels[skill],
    skillRule: skillDescriptions[skill],
    internalRevision: 1,
    status: "deployed",
    createdAt: now,
    updatedAt: now,
    deployedAt: now,
  };
}

function snapshotFromState(state: PlatformState): PlatformSnapshot {
  const usersById = new Map(state.users.map((user) => [user.userId, user]));
  const records = computeRecords(state);
  const leaderboard = state.balls
    .map((ball) => {
      const record = records.get(ball.ballId) ?? emptyRecord();
      const ownerName = usersById.get(ball.ownerId)?.displayName ?? "未知用户";
      return {
        ballId: ball.ballId,
        ballName: ball.name,
        ownerName,
        score: Math.round(record.wins * 1000 + record.bestScore + Math.max(0, 10 - record.avgRank) * 20),
        matches: record.matches,
        wins: record.wins,
        avgRank: record.avgRank,
      };
    })
    .sort((a, b) => b.score - a.score || b.wins - a.wins || a.avgRank - b.avgRank);
  return {
    users: state.users.map(publicUser),
    balls: state.balls.map((ball) => ({
      ...ball,
      ownerName: usersById.get(ball.ownerId)?.displayName ?? "未知用户",
      record: records.get(ball.ballId) ?? emptyRecord(),
      agentProfileLabel: profileLabels[ball.agentProfile],
      skillLabel: ball.skillName || skillLabels[ball.skill ?? "none"],
      skillDescription: ball.skillRule || skillDescriptions[ball.skill ?? "none"],
    })),
    matches: state.matches,
    editRecords: state.editRecords,
    leaderboard,
    deployedBallIds: state.balls.filter((ball) => ball.status === "deployed").map((ball) => ball.ballId),
    userLimits: {
      maxBallsPerUser: MAX_BALLS_PER_USER,
    },
    sharePort: {
      label: "智能体球球编辑上传端口",
      method: "提交球球专属编号、编辑规则、可选托管档位、自由技能和触发规则",
      fields: ["actor", "ballId", "editRule", "profile", "skill", "skillRule"],
    },
    agentRules: {
      userCanEdit: ["球球名称", "颜色", "花纹"],
      agentOnly: ["策略档位", "专属技能", "触发条件", "风险阈值", "地图偏好", "追击/撤退优先级"],
    },
  };
}

function publicUser(user: PlatformUser): PlatformUser {
  return {
    userId: user.userId,
    displayName: user.displayName,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

function computeRecords(state: PlatformState): Map<string, BallRecord> {
  const records = new Map<string, BallRecord>();
  for (const match of state.matches) {
    for (const result of match.results) {
      const record = records.get(result.ballId) ?? emptyRecord();
      record.matches += 1;
      record.wins += result.rank === 1 ? 1 : 0;
      record.avgRank += result.rank;
      record.bestRank = record.bestRank === null ? result.rank : Math.min(record.bestRank, result.rank);
      record.bestScore = Math.max(record.bestScore, result.score);
      record.lastRank = record.lastRank ?? result.rank;
      record.lastScore = record.lastScore || result.score;
      record.totalKills += result.kills;
      record.totalDeaths += result.deaths;
      records.set(result.ballId, record);
    }
  }
  for (const record of records.values()) {
    record.avgRank = record.matches === 0 ? 0 : round(record.avgRank / record.matches);
  }
  return records;
}

function emptyRecord(): BallRecord {
  return {
    matches: 0,
    wins: 0,
    avgRank: 0,
    bestRank: null,
    bestScore: 0,
    lastRank: null,
    lastScore: 0,
    totalKills: 0,
    totalDeaths: 0,
  };
}

function findOrCreateUser(state: PlatformState, ownerId: string | undefined, ownerName: string | undefined, now: string) {
  const cleanName = cleanText(ownerName, "新用户", 12);
  if (ownerId) {
    const cleanOwnerId = cleanIdentifier(ownerId);
    if (cleanOwnerId) {
      const existing = state.users.find((user) => user.userId === cleanOwnerId);
      if (existing) {
        existing.displayName = cleanName;
        return existing;
      }
      const user = { userId: cleanOwnerId, displayName: cleanName, createdAt: now };
      state.users.unshift(user);
      return user;
    }
  }
  const sameName = state.users.find((user) => user.displayName === cleanName);
  if (sameName) return sameName;
  const user = { userId: makeId("user"), displayName: cleanName, createdAt: now };
  state.users.unshift(user);
  return user;
}

function mustFindBall(state: PlatformState, ballId: string): PlatformBall {
  const ball = state.balls.find((item) => item.ballId === ballId);
  if (!ball) throw new Error("没有找到这个球球");
  return ball;
}

function selectBattleBalls(state: PlatformState, ballIds: string[] | undefined): PlatformBall[] {
  const requested = Array.isArray(ballIds) && ballIds.length > 0
    ? ballIds.map((id) => mustFindBall(state, id))
    : state.balls.filter((ball) => ball.status === "deployed");
  return requested.filter((ball) => ball.status === "deployed").slice(0, 8);
}

function normalizeState(state: PlatformState): PlatformState {
  let changed = false;
  const now = Date.now();
  if (!Array.isArray(state.authCodes)) {
    state.authCodes = [];
    changed = true;
  } else {
    const activeCodes = state.authCodes.filter((record) => Date.parse(record.expiresAt) > now);
    if (activeCodes.length !== state.authCodes.length) {
      state.authCodes = activeCodes;
      changed = true;
    }
  }
  if (!Array.isArray(state.authSessions)) {
    state.authSessions = [];
    changed = true;
  } else {
    const activeSessions = state.authSessions.filter((record) => Date.parse(record.expiresAt) > now);
    if (activeSessions.length !== state.authSessions.length) {
      state.authSessions = activeSessions;
      changed = true;
    }
  }
  if (!Array.isArray(state.editRecords)) {
    state.editRecords = [];
    changed = true;
  }
  for (const ball of state.balls) {
    if (!isBallSkill(ball.skill)) {
      ball.skill = "none";
      changed = true;
    }
    if (!ball.skillName) {
      ball.skillName = skillLabels[ball.skill];
      changed = true;
    }
    if (!ball.skillRule) {
      ball.skillRule = skillDescriptions[ball.skill];
      changed = true;
    }
    if (ball.status !== "deployed") {
      ball.status = "deployed";
      ball.deployedAt = ball.deployedAt ?? ball.updatedAt;
      changed = true;
    }
  }
  const keptByOwner = new Map<string, number>();
  const keptBallIds = new Set<string>();
  const cappedBalls = state.balls.filter((ball) => {
    const count = keptByOwner.get(ball.ownerId) ?? 0;
    if (count >= MAX_BALLS_PER_USER) return false;
    keptByOwner.set(ball.ownerId, count + 1);
    keptBallIds.add(ball.ballId);
    return true;
  });
  if (cappedBalls.length !== state.balls.length) {
    state.balls = cappedBalls;
    state.editRecords = state.editRecords.filter((record) => keptBallIds.has(record.ballId));
    state.matches = state.matches
      .map((match) => ({
        ...match,
        participantBallIds: match.participantBallIds.filter((ballId) => keptBallIds.has(ballId)),
        results: match.results.filter((result) => keptBallIds.has(result.ballId)),
      }))
      .filter((match) => match.results.length >= 2);
    changed = true;
  }
  if (state.editRecords.length === 0 && state.balls.length > 0) {
    state.editRecords = state.balls.map((ball) => ({
      ...makeEditRecord(state, ball, "user", "create", "用户创建球球"),
      editId: `edit_${ball.ballId}_created`,
      createdAt: ball.createdAt,
    }));
    changed = true;
  }
  return changed ? { ...state } : state;
}

function makeEditRecord(
  state: PlatformState,
  ball: PlatformBall,
  actor: BallEditActor,
  type: BallEditType,
  summary: string,
  ruleText?: string,
  beforeProfile?: AgentProfile,
  afterProfile?: AgentProfile,
): BallEditRecord {
  const owner = state.users.find((user) => user.userId === ball.ownerId);
  return {
    editId: makeId("edit"),
    ballId: ball.ballId,
    ballName: ball.name,
    ownerId: ball.ownerId,
    ownerName: owner?.displayName ?? "未知用户",
    actor,
    type,
    summary,
    ruleText: cleanOptionalText(ruleText, 120),
    beforeProfile,
    afterProfile,
    createdAt: new Date().toISOString(),
  };
}

function agentEntryForBall(ball: PlatformBall): AgentEntry {
  return {
    agentId: agentIdForBall(ball.ballId),
    name: ball.name,
    strategy: strategyForBall(ball),
  };
}

function buildMatchRecord(
  replay: Replay,
  balls: PlatformBall[],
  users: PlatformUser[],
  seed: number,
  durationSeconds: number,
): PlatformMatchRecord {
  const ballByAgentId = new Map(balls.map((ball) => [agentIdForBall(ball.ballId), ball]));
  const usersById = new Map(users.map((user) => [user.userId, user]));
  const results = replay.results.map((result) => resultForRecord(result, ballByAgentId, usersById));
  return {
    matchId: replay.matchId,
    seed,
    createdAt: new Date().toISOString(),
    durationSeconds,
    participantBallIds: balls.map((ball) => ball.ballId),
    winnerBallId: results[0]?.ballId,
    replayFile: "last-replay.json",
    results,
  };
}

function resultForRecord(
  result: MatchResult,
  ballByAgentId: Map<string, PlatformBall>,
  usersById: Map<string, PlatformUser>,
): PlatformBattleResult {
  const ball = ballByAgentId.get(result.agentId);
  if (!ball) throw new Error("对局结果缺少球球映射");
  return {
    ballId: ball.ballId,
    agentId: result.agentId,
    ownerId: ball.ownerId,
    ownerName: usersById.get(ball.ownerId)?.displayName ?? "未知用户",
    ballName: ball.name,
    rank: result.rank,
    score: round(result.score),
    alive: result.alive,
    finalMass: round(result.metrics.finalMass),
    kills: result.metrics.kills,
    deaths: result.metrics.deaths,
    survivalTime: round(result.metrics.survivalTime),
    foodPickedMass: round(result.metrics.foodPickedMass),
    burstsTotal: result.metrics.burstsTotal,
    burstsEffective: result.metrics.burstsEffective,
  };
}

function writePlatformReplay(replay: Replay, outDir: string) {
  mkdirSync(outDir, { recursive: true });
  const replayPath = path.join(outDir, "last-replay.json");
  const eventsPath = path.join(outDir, "last-events.json");
  const metricsPath = path.join(outDir, "last-metrics.json");
  writeFileSync(replayPath, JSON.stringify(replay));
  writeFileSync(eventsPath, JSON.stringify(replay.events, null, 2));
  writeFileSync(metricsPath, JSON.stringify(replay.results.map((result) => ({ name: result.name, ...result.metrics })), null, 2));
  return { replayPath, eventsPath, metricsPath };
}

function normalizeAppearance(input: Partial<BallAppearance> | undefined, fallback = defaultAppearance): BallAppearance {
  return {
    color: normalizeColor(input?.color, fallback.color),
    accentColor: normalizeColor(input?.accentColor, fallback.accentColor),
    pattern: input?.pattern === "solid" || input?.pattern === "ring" || input?.pattern === "spark" ? input.pattern : fallback.pattern,
  };
}

function isAgentProfile(value: unknown): value is AgentProfile {
  return value === "balanced" || value === "conservative" || value === "greedy";
}

function isBallSkill(value: unknown): value is BallSkillMode {
  return (
    value === "none" ||
    value === "forage" ||
    value === "evade" ||
    value === "dash" ||
    value === "hunt" ||
    value === "edge" ||
    value === "center" ||
    value === "shadow"
  );
}

function inferProfileFromRule(ruleText: string | undefined): AgentProfile {
  const text = ruleText ?? "";
  if (/进攻|追击|激进|吞噬|冲刺/.test(text)) return "greedy";
  if (/稳健|保守|逃跑|生存|防守/.test(text)) return "conservative";
  return "balanced";
}

function inferSkillFromRule(ruleText: string | undefined): BallSkillMode | undefined {
  const text = ruleText ?? "";
  if (/中心|控场|中场|地图中央|资源区|高资源/.test(text)) return "center";
  if (/猎手|猎杀|收割|击杀|吃人|吞噬|追小球|抓机会/.test(text)) return "hunt";
  if (/贴边|边线|边缘|墙边|角落|沿边/.test(text)) return "edge";
  if (/影子|绕行|尾随|侧翼|游走|拉扯/.test(text)) return "shadow";
  if (/避险|闪避|逃生|保命|防守|稳健|生存|求生|空旷|大球/.test(text)) return "evade";
  if (/短冲|冲刺|爆发|追击|突进/.test(text)) return "dash";
  if (/觅食|吃豆|营养|发育|资源/.test(text)) return "forage";
  return undefined;
}

function normalizeSkillInput(ball: PlatformBall, input: AgentTuneInput): { mode: BallSkillMode; name: string; rule: string } {
  const rawSkill = cleanOptionalText(input.skill, 80);
  const rawRule = cleanOptionalText(input.skillRule, 180);
  const previousMode = isBallSkill(ball.skill) ? ball.skill : "none";

  if (!rawSkill && !rawRule) {
    const inferred = inferSkillFromRule(input.editRule);
    const mode = inferred ?? previousMode;
    return {
      mode,
      name: ball.skillName || skillLabels[mode],
      rule: ball.skillRule || skillDescriptions[mode],
    };
  }

  if (rawSkill === "none") {
    return { mode: "none", name: skillLabels.none, rule: skillDescriptions.none };
  }

  const mode = isBallSkill(rawSkill)
    ? rawSkill
    : inferSkillFromRule(rawSkill) ?? inferSkillFromRule(rawRule) ?? inferSkillFromRule(input.editRule) ?? previousMode;
  return {
    mode,
    name: isBallSkill(rawSkill) ? skillLabels[rawSkill] : cleanText(rawSkill, skillLabels[mode], 18),
    rule: rawRule ?? (isBallSkill(rawSkill) ? skillDescriptions[rawSkill] : rawSkill ?? skillDescriptions[mode]),
  };
}

function strategyForBall(ball: PlatformBall): StrategyFn {
  const base = strategyByProfile[ball.agentProfile];
  const skill = ball.skill ?? "none";
  if (skill === "forage") return withForageSkill(base);
  if (skill === "evade") return withEvadeSkill(base);
  if (skill === "dash") return withDashSkill(base);
  if (skill === "hunt") return withHuntSkill(base);
  if (skill === "edge") return withEdgeSkill(base);
  if (skill === "center") return withCenterSkill(base);
  if (skill === "shadow") return withShadowSkill(base);
  return base;
}

function withForageSkill(base: StrategyFn): StrategyFn {
  return (me, world) => {
    const threat = nearestThreat(me, world);
    const threatDistance = threat ? distance(me.position, threat.position) : Infinity;
    const safe = !threat || threatDistance > Math.max(me.radius * 5.5, 180);
    if (safe) {
      const food = world.foods
        .filter((item) => item.mass >= 5)
        .sort((a, b) => foodScore(me, b.position, b.mass) - foodScore(me, a.position, a.mass))[0];
      if (food) return { type: "move", target: food.position };
    }
    return base(me, world);
  };
}

function withEvadeSkill(base: StrategyFn): StrategyFn {
  return (me, world) => {
    const threat = nearestThreat(me, world);
    if (threat) {
      const threatDistance = distance(me.position, threat.position);
      const earlyWarningDistance = Math.max(me.radius * 5.5, 150);
      if (threatDistance < earlyWarningDistance) {
        const away = unitFrom(threat.position, me.position);
        if (me.burstCooldown === 0 && me.mass >= 24 && threatDistance < Math.max(me.radius * 3.6, 95)) {
          return { type: "burst", direction: away };
        }
        return {
          type: "move",
          target: clampToMap({
            x: me.position.x + away.dx * 850,
            y: me.position.y + away.dy * 850,
          }, world.mapBounds),
        };
      }
    }
    return base(me, world);
  };
}

function withDashSkill(base: StrategyFn): StrategyFn {
  return (me, world) => {
    const baseAction = base(me, world);
    if (baseAction.type === "burst" && me.mass < 30) {
      return { type: "move", target: clampToMap({ x: me.position.x + baseAction.direction.dx * 500, y: me.position.y + baseAction.direction.dy * 500 }, world.mapBounds) };
    }
    if (baseAction.type !== "move" || me.burstCooldown !== 0 || me.mass < 30) return baseAction;

    const chase = world.enemies
      .filter((enemy) => !enemy.invulnerable && enemy.mass <= me.mass * 0.62)
      .filter((enemy) => distance(me.position, enemy.position) < Math.max(me.radius * 5, 160))
      .sort((a, b) => distance(me.position, a.position) - distance(me.position, b.position))[0];
    if (chase && distance(baseAction.target, chase.position) < Math.max(me.radius * 3, 90)) {
      return { type: "burst", direction: unitFrom(me.position, chase.position) };
    }
    return baseAction;
  };
}

function withHuntSkill(base: StrategyFn): StrategyFn {
  return (me, world) => {
    const threat = nearestThreat(me, world);
    const threatDistance = threat ? distance(me.position, threat.position) : Infinity;
    const prey = nearestPrey(me, world, 0.72);
    if (prey && threatDistance > Math.max(me.radius * 4.8, 150)) {
      const preyDistance = distance(me.position, prey.position);
      if (me.burstCooldown === 0 && me.mass >= 32 && preyDistance < Math.max(me.radius * 5.8, 220)) {
        return { type: "burst", direction: unitFrom(me.position, prey.position) };
      }
      return { type: "move", target: prey.position };
    }
    return base(me, world);
  };
}

function withEdgeSkill(base: StrategyFn): StrategyFn {
  return (me, world) => {
    const threat = nearestThreat(me, world);
    const underPressure = !!threat && distance(me.position, threat.position) < Math.max(me.radius * 6.2, 210);
    const fragile = me.livesRemaining <= 1 || me.mass < 28;
    if (underPressure || fragile) {
      const safeEdge = nearestSafeEdgePoint(me, world);
      if (threat && me.burstCooldown === 0 && me.mass >= 26 && distance(me.position, threat.position) < Math.max(me.radius * 3.8, 110)) {
        return { type: "burst", direction: unitFrom(threat.position, me.position) };
      }
      return { type: "move", target: safeEdge };
    }
    return base(me, world);
  };
}

function withCenterSkill(base: StrategyFn): StrategyFn {
  return (me, world) => {
    const threat = nearestThreat(me, world);
    const threatDistance = threat ? distance(me.position, threat.position) : Infinity;
    if (threatDistance < Math.max(me.radius * 5, 170)) return base(me, world);

    const cluster = richestFoodCluster(me, world);
    const center = { x: world.mapBounds.w / 2, y: world.mapBounds.h / 2 };
    if (cluster && distance(cluster, center) < world.viewRadius * 0.8) {
      return { type: "move", target: cluster };
    }
    if (distance(me.position, center) > Math.max(me.radius * 8, 260)) {
      return { type: "move", target: center };
    }
    return base(me, world);
  };
}

function withShadowSkill(base: StrategyFn): StrategyFn {
  return (me, world) => {
    const anchor = nearestThreat(me, world);
    if (!anchor) return base(me, world);

    const anchorDistance = distance(me.position, anchor.position);
    const minSafeDistance = Math.max(me.radius * 6.5, anchor.radius * 2.4, 230);
    if (anchorDistance < minSafeDistance * 0.82) {
      const away = unitFrom(anchor.position, me.position);
      return { type: "move", target: clampToMap({ x: me.position.x + away.dx * 760, y: me.position.y + away.dy * 760 }, world.mapBounds) };
    }

    const nearbyFood = world.foods
      .filter((food) => distance(food.position, anchor.position) < minSafeDistance * 1.35)
      .sort((a, b) => foodScore(me, b.position, b.mass) - foodScore(me, a.position, a.mass))[0];
    if (nearbyFood && anchorDistance > minSafeDistance) return { type: "move", target: nearbyFood.position };

    const tangent = tangentAround(me.position, anchor.position);
    return { type: "move", target: clampToMap({ x: me.position.x + tangent.dx * 520, y: me.position.y + tangent.dy * 520 }, world.mapBounds) };
  };
}

function nearestThreat(me: SelfView, world: WorldView): EnemyView | undefined {
  return world.enemies
    .filter((enemy) => !enemy.invulnerable && enemy.mass >= me.mass * 1.15)
    .sort((a, b) => distance(me.position, a.position) - distance(me.position, b.position))[0];
}

function nearestPrey(me: SelfView, world: WorldView, maxMassRatio: number): EnemyView | undefined {
  return world.enemies
    .filter((enemy) => !enemy.invulnerable && enemy.mass <= me.mass * maxMassRatio)
    .sort((a, b) => distance(me.position, a.position) - distance(me.position, b.position))[0];
}

function richestFoodCluster(me: SelfView, world: WorldView): Pos | undefined {
  const candidates = world.foods
    .filter((food) => food.mass >= 3)
    .map((food) => {
      const nearby = world.foods.filter((other) => distance(food.position, other.position) < 260);
      const mass = nearby.reduce((sum, other) => sum + other.mass, 0);
      return { position: food.position, score: mass * 8 - distance(me.position, food.position) * 0.035 };
    })
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.position;
}

function nearestSafeEdgePoint(me: SelfView, world: WorldView): Pos {
  const margin = Math.max(me.radius * 3, 140);
  const candidates: Pos[] = [
    { x: margin, y: me.position.y },
    { x: world.mapBounds.w - margin, y: me.position.y },
    { x: me.position.x, y: margin },
    { x: me.position.x, y: world.mapBounds.h - margin },
  ].map((point) => clampToMap(point, world.mapBounds));

  return candidates
    .map((point) => ({
      point,
      nearestThreatDistance: Math.min(...world.enemies
        .filter((enemy) => !enemy.invulnerable && enemy.mass >= me.mass)
        .map((enemy) => distance(point, enemy.position)), Infinity),
      travelDistance: distance(me.position, point),
    }))
    .sort((a, b) => (b.nearestThreatDistance - b.travelDistance * 0.25) - (a.nearestThreatDistance - a.travelDistance * 0.25))[0].point;
}

function foodScore(me: SelfView, position: Pos, mass: number): number {
  return mass * 10 - distance(me.position, position) * 0.045;
}

function distance(a: Pos, b: Pos): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function unitFrom(from: Pos, to: Pos): { dx: number; dy: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const m = Math.hypot(dx, dy) || 1;
  return { dx: dx / m, dy: dy / m };
}

function tangentAround(from: Pos, around: Pos): { dx: number; dy: number } {
  const radial = unitFrom(around, from);
  return { dx: -radial.dy, dy: radial.dx };
}

function clampToMap(p: Pos, b: { w: number; h: number }): Pos {
  return {
    x: Math.max(50, Math.min(b.w - 50, p.x)),
    y: Math.max(50, Math.min(b.h - 50, p.y)),
  };
}

function normalizeColor(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const clean = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(clean) ? clean : fallback;
}

function cleanText(value: string | undefined, fallback: string, maxLength: number): string {
  const clean = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!clean) return fallback;
  return clean.slice(0, maxLength);
}

function cleanOptionalText(value: string | undefined, maxLength: number): string | undefined {
  const clean = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return clean ? clean.slice(0, maxLength) : undefined;
}

function cleanIdentifier(value: string | undefined): string | undefined {
  const clean = typeof value === "string" ? value.trim() : "";
  if (!/^[a-zA-Z0-9_-]{6,48}$/.test(clean)) return undefined;
  return clean;
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function hashEmail(email: string): string {
  return createHash("sha256").update(email).digest("hex");
}

function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value ?? fallback);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function agentIdForBall(ballId: string): string {
  return `agent_${ballId}`;
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function stateFile(outDir: string): string {
  if (path.basename(outDir) === "out") {
    return path.join(path.dirname(outDir), "data", "platform-state.json");
  }
  return path.join(outDir, "platform-state.json");
}

function defaultOutDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "out");
}
