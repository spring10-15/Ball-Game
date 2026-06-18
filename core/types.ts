/**
 * Agent 球球大作战 · 核心类型定义
 *
 * 这是 SDK / 模拟器 / API / 策略代码之间的对外契约。
 * 修改这个文件 = 修改产品边界，必须同步更新 design-spec.md 和 AGENT_GUIDE.md。
 */

// ---------------------------------------------------------------------------
// 基础几何
// ---------------------------------------------------------------------------

export interface Pos {
  x: number;
  y: number;
}

export interface Vec {
  dx: number;
  dy: number;
}

export interface MapBounds {
  w: number;
  h: number;
}

// ---------------------------------------------------------------------------
// 视图：传给策略代码 onTick 的两个参数
// ---------------------------------------------------------------------------

/** 策略对"自己"的视图。所有字段都基于最新一 tick 状态算好。 */
export interface SelfView {
  /** 球实例 id，复活后会换新 id */
  id: string;
  position: Pos;
  velocity: { x: number; y: number };
  radius: number;
  mass: number;
  /** 当前质量对应的速度上限，模拟器已经算好 */
  maxSpeed: number;
  /** 包含当前这条命，复活用完后归 0 */
  livesRemaining: number;
  /** 距离下次可 burst 的秒数；0 表示就绪 */
  burstCooldown: number;
  /** 无敌帧截止时间（绝对秒），world.time < invulnUntil 时无敌；0 表示无 */
  invulnUntil: number;
  /** 本局累计综合分 */
  score: number;
  /** 本条命存活时间（秒） */
  survivalTime: number;
}

export interface FoodView {
  id: string;
  position: Pos;
  mass: number;
}

export interface EnemyView {
  /** 球实例 id */
  id: string;
  /** 球所属 agent 的稳定 id */
  agentId: string;
  position: Pos;
  velocity: { x: number; y: number };
  radius: number;
  mass: number;
  livesRemaining: number;
  /** 是否在无敌帧 */
  invulnerable: boolean;
}

export interface BurstView {
  agentId: string;
  /** burst 触发的起点位置 */
  position: Pos;
  /** burst 方向（单位向量） */
  direction: Vec;
  /** burst 残影已存在的秒数 */
  ageSeconds: number;
}

export interface RankingEntry {
  agentId: string;
  name: string;
  rank: number;
  score: number;
  alive: boolean;
}

/** 视野范围内的世界视图。 */
export interface WorldView {
  tick: number;
  /** 本局已过秒数 */
  time: number;
  /** 本局剩余秒数 */
  timeRemaining: number;
  /** 当前视野半径，已经按自身质量算好 */
  viewRadius: number;
  mapBounds: MapBounds;
  foods: FoodView[];
  enemies: EnemyView[];
  bursts: BurstView[];
  /** 全局排名摘要：仅名次和分数，不暴露视野外位置 */
  rankings: RankingEntry[];
}

// ---------------------------------------------------------------------------
// 动作：策略返回值
// ---------------------------------------------------------------------------

export type Action =
  | { type: "move"; target: Pos }
  | { type: "burst"; direction: Vec }
  | { type: "idle" };

/** 策略入口签名 */
export type StrategyFn = (me: SelfView, world: WorldView) => Action;

// ---------------------------------------------------------------------------
// Replay 事件流
// ---------------------------------------------------------------------------

export type EventBase = {
  /** 事件发生时刻（本局秒数） */
  time: number;
  /** 事件发生的 tick 序号 */
  tick: number;
};

export type SpawnEvent = EventBase & {
  type: "spawn";
  agentId: string;
  ballId: string;
  position: Pos;
  livesRemaining: number;
};

export type DeathEvent = EventBase & {
  type: "death";
  agentId: string;
  ballId: string;
  killerId?: string;
  killerAgentId?: string;
  reason: "eaten" | "wall" | "self-burst" | "timeout";
};

export type KillEvent = EventBase & {
  type: "kill";
  killerId: string;
  killerAgentId: string;
  victimId: string;
  victimAgentId: string;
  massGained: number;
};

export type BurstEvent = EventBase & {
  type: "burst";
  agentId: string;
  ballId: string;
  direction: Vec;
  cost: number;
};

export type BurstSavedEvent = EventBase & {
  type: "burst-saved";
  agentId: string;
  almostKilledBy: string;
};

export type DangerEnterEvent = EventBase & {
  type: "danger-enter";
  agentId: string;
  threatAgentId: string;
};

export type DangerExitEvent = EventBase & {
  type: "danger-exit";
  agentId: string;
  threatAgentId: string;
};

export type FoodPickupEvent = EventBase & {
  type: "food-pickup";
  agentId: string;
  mass: number;
};

export type DecisionErrorEvent = EventBase & {
  type: "decision-error";
  agentId: string;
  message: string;
};

export type GameEndEvent = EventBase & {
  type: "game-end";
  reason: "last-standing" | "timeout" | "all-dead";
  winnerAgentId?: string;
};

export type Event =
  | SpawnEvent
  | DeathEvent
  | KillEvent
  | BurstEvent
  | BurstSavedEvent
  | DangerEnterEvent
  | DangerExitEvent
  | FoodPickupEvent
  | DecisionErrorEvent
  | GameEndEvent;

// ---------------------------------------------------------------------------
// Replay & Metrics
// ---------------------------------------------------------------------------

export interface DecisionTrace {
  agentId: string;
  action: "move" | "burst" | "idle";
  focus: string;
  risk: "安全" | "注意" | "危险";
  reason: string;
  target?: Pos;
}

/** 一帧完整状态，用于前端 Canvas 重放。生产环境会压缩为二进制；这里是 JSON 友好版 */
export interface ReplayFrame {
  tick: number;
  time: number;
  balls: Array<{
    id: string;
    agentId: string;
    position: Pos;
    radius: number;
    mass: number;
    velocity: { x: number; y: number };
    invulnerable: boolean;
  }>;
  foods: FoodView[];
  bursts: BurstView[];
  decisions?: DecisionTrace[];
}

export interface Replay {
  matchId: string;
  seed: number;
  config: MatchConfig;
  frames: ReplayFrame[];
  events: Event[];
  results: MatchResult[];
}

export interface MatchMetrics {
  agentId: string;
  finalRank: number;
  finalMass: number;
  kills: number;
  deaths: number;
  survivalTime: number;
  foodPickedMass: number;
  burstsTotal: number;
  burstsEffective: number;
  dangerSeconds: number;
  decisionErrors: number;
  score: number;
  eloDelta: number;
}

export interface MatchResult {
  agentId: string;
  name: string;
  rank: number;
  score: number;
  alive: boolean;
  livesUsed: number;
  metrics: MatchMetrics;
}

// ---------------------------------------------------------------------------
// 局配置
// ---------------------------------------------------------------------------

export interface AgentEntry {
  agentId: string;
  name: string;
  strategy: StrategyFn;
}

export interface MatchConfig {
  seed: number;
  map: MapBounds;
  durationSeconds: number;
  tickRate: number;       // 30
  decisionRate: number;   // 10
  initialMass: number;
  baseSpeed: number;
  eatRatio: number;       // 1.15
  burst: {
    massCostRatio: number;        // 0.08
    speedMultiplier: number;      // 2.2
    durationSeconds: number;      // 1.2
    cooldownSeconds: number;      // 8
    minMassRatio: number;         // 1.2 (与 initialMass 比)
  };
  revive: {
    maxLives: number;             // 3
    cooldownSeconds: number;      // 5
    invulnSeconds: number;        // 2
    minDistanceFromLargest: number; // 1500
  };
  view: {
    base: number;        // 800
    massCoef: number;    // 8
    max: number;         // 2000
  };
  food: {
    smallMass: number;          // 1
    mediumMass: number;         // 5
    largeMass: number;          // 20
    smallRatio: number;         // 0.80
    mediumRatio: number;        // 0.15
    largeRatio: number;         // 0.05
    densityMultiplier: number;  // 4 (相对初始玩家总质量)
  };
  scoring: {
    massWeight: number;             // 1.0
    killWeight: number;             // 50
    survivalSecondWeight: number;   // 0.5
    remainingLifeWeight: number;    // 100
    dangerSecondPenalty: number;    // 2
  };
  lastStandingHoldSeconds: number;  // 10
}

/** 默认配置，对应 design-spec.md §2 与 §3 的数值 */
export const DEFAULT_CONFIG: MatchConfig = {
  seed: 0,
  map: { w: 4000, h: 4000 },
  durationSeconds: 300,
  tickRate: 30,
  decisionRate: 10,
  initialMass: 20,
  baseSpeed: 220,
  eatRatio: 1.15,
  burst: {
    massCostRatio: 0.08,
    speedMultiplier: 2.2,
    durationSeconds: 1.2,
    cooldownSeconds: 8,
    minMassRatio: 1.2,
  },
  revive: {
    maxLives: 3,
    cooldownSeconds: 5,
    invulnSeconds: 2,
    minDistanceFromLargest: 1500,
  },
  view: {
    base: 800,
    massCoef: 8,
    max: 2000,
  },
  food: {
    smallMass: 1,
    mediumMass: 5,
    largeMass: 20,
    smallRatio: 0.80,
    mediumRatio: 0.15,
    largeRatio: 0.05,
    densityMultiplier: 4,
  },
  scoring: {
    massWeight: 1.0,
    killWeight: 50,
    survivalSecondWeight: 0.5,
    remainingLifeWeight: 100,
    dangerSecondPenalty: 2,
  },
  lastStandingHoldSeconds: 10,
};
