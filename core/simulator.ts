/**
 * Agent 球球大作战 · 最小可运行模拟引擎
 *
 * 这是 v0 的"骨架"实现，目标是能在 Node 本地跑通一局，输出 replay 与 events。
 * 还没接 isolated-vm 真沙盒（策略代码直接当 JS 函数调用，假设可信）。
 *
 * 关键设计：
 * - 确定性：通过 seedable PRNG 保证 (seed + 策略集合) -> 相同输出
 * - tick 30Hz，决策 10Hz（每 3 tick 调一次策略）
 * - 视野裁剪：传给策略的 WorldView 只含视野内实体
 * - 决策错误 / 超时 -> 降级 idle 且记 events
 *
 * 还没实现的（v0+ 再补）：
 * - 真沙盒（isolated-vm / QuickJS）
 * - 决策 CPU 超时强制中断（v0 用 wall-clock 测量后记 events，不中断）
 * - 二进制 replay 压缩
 */

import {
  Action,
  AgentEntry,
  BurstView,
  DEFAULT_CONFIG,
  DecisionTrace,
  EnemyView,
  Event,
  FoodView,
  MatchConfig,
  MatchMetrics,
  MatchResult,
  Pos,
  Replay,
  ReplayFrame,
  SelfView,
  WorldView,
} from "./types.js";

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** Mulberry32 PRNG，便于确定性回放 */
function makeRng(seed: number): () => number {
  let a = seed | 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dist2 = (a: Pos, b: Pos) => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};
const dist = (a: Pos, b: Pos) => Math.sqrt(dist2(a, b));
const radiusOf = (mass: number) => Math.sqrt(mass) * 4; // 与 mass 成 sqrt 关系，常数任选
const speedOf = (cfg: MatchConfig, mass: number) =>
  cfg.baseSpeed / Math.sqrt(mass / cfg.initialMass);
const viewRadiusOf = (cfg: MatchConfig, radius: number) =>
  Math.min(cfg.view.max, Math.max(cfg.view.base, radius * cfg.view.massCoef));

// ---------------------------------------------------------------------------
// 内部状态
// ---------------------------------------------------------------------------

interface Ball {
  id: string;
  agentId: string;
  position: Pos;
  velocity: { x: number; y: number };
  mass: number;
  alive: boolean;
  burstUntil: number;       // 绝对秒
  burstCooldownUntil: number;
  invulnUntil: number;
  spawnedAt: number;
  /** 当前目标点（来自最近一次 move 动作） */
  moveTarget?: Pos;
  /** 当前 burst 方向（已归一化），有效期内有用 */
  burstDir?: { x: number; y: number };
}

interface AgentState {
  agentId: string;
  name: string;
  strategy: AgentEntry["strategy"];
  livesRemaining: number;
  deathPendingUntil: number; // 复活就绪时间，绝对秒
  cumulativeScore: number;
  cumulativeSurvival: number;
  cumulativeFoodMass: number;
  kills: number;
  deaths: number;
  burstsTotal: number;
  burstsEffective: number;
  dangerSeconds: number;
  decisionErrors: number;
  /** 当前在危险接近中的威胁集合（用于 burst-saved 判定） */
  activeThreats: Set<string>;
  /** 最近一次有效 burst 的时间，用于衡量 burst 后击杀/脱险效果 */
  lastBurstAt: number;
  effectiveBurstTicks: Set<number>;
  /** 当前活球，复活/死亡时切换 */
  ballId?: string;
}

interface Food {
  id: string;
  position: Pos;
  mass: number;
}

interface Burst {
  agentId: string;
  position: Pos;
  direction: { x: number; y: number };
  bornAt: number;
}

// ---------------------------------------------------------------------------
// 主模拟器
// ---------------------------------------------------------------------------

export interface RunOptions {
  agents: AgentEntry[];
  config?: Partial<MatchConfig>;
  matchId?: string;
  /** 调试日志 */
  verbose?: boolean;
}

export function runMatch(options: RunOptions): Replay {
  const cfg: MatchConfig = { ...DEFAULT_CONFIG, ...(options.config ?? {}) };
  const rng = makeRng(cfg.seed);

  const matchId = options.matchId ?? `m_${cfg.seed}_${Date.now().toString(36)}`;
  const tickDt = 1 / cfg.tickRate;
  const decisionEveryNTick = Math.round(cfg.tickRate / cfg.decisionRate);
  const totalTicks = cfg.durationSeconds * cfg.tickRate;

  // ---------- 初始化 agent 状态 ----------
  const agents = new Map<string, AgentState>();
  const balls = new Map<string, Ball>();
  let ballIdCounter = 0;
  const makeBallId = () => `b${++ballIdCounter}`;

  for (const entry of options.agents) {
    agents.set(entry.agentId, {
      agentId: entry.agentId,
      name: entry.name,
      strategy: entry.strategy,
      livesRemaining: cfg.revive.maxLives,
      deathPendingUntil: 0,
      cumulativeScore: 0,
      cumulativeSurvival: 0,
      cumulativeFoodMass: 0,
      kills: 0,
      deaths: 0,
      burstsTotal: 0,
      burstsEffective: 0,
      dangerSeconds: 0,
      decisionErrors: 0,
      activeThreats: new Set(),
      lastBurstAt: -Infinity,
      effectiveBurstTicks: new Set(),
    });
  }

  // ---------- 初始营养块 ----------
  const foods = new Map<string, Food>();
  let foodIdCounter = 0;
  const initialPlayerMass = cfg.initialMass * options.agents.length;
  const targetFoodMass = initialPlayerMass * cfg.food.densityMultiplier;

  const spawnFood = () => {
    const r = rng();
    let mass: number;
    if (r < cfg.food.smallRatio) mass = cfg.food.smallMass;
    else if (r < cfg.food.smallRatio + cfg.food.mediumRatio) mass = cfg.food.mediumMass;
    else mass = cfg.food.largeMass;
    const id = `f${++foodIdCounter}`;
    foods.set(id, {
      id,
      mass,
      position: { x: rng() * cfg.map.w, y: rng() * cfg.map.h },
    });
  };

  // 初始一次性铺满
  let totalFoodMass = 0;
  while (totalFoodMass < targetFoodMass) {
    spawnFood();
    totalFoodMass = sumFoodMass(foods);
  }

  // ---------- burst 残影 ----------
  const bursts: Burst[] = [];

  // ---------- 事件流 ----------
  const events: Event[] = [];
  const frames: ReplayFrame[] = [];
  const latestDecisions = new Map<string, DecisionTrace>();

  // ---------- 复活/初始 spawn ----------
  const findSpawnPoint = (time: number): Pos => {
    const largest = largestAliveBall(balls);
    for (let attempt = 0; attempt < 50; attempt++) {
      const p = { x: rng() * cfg.map.w, y: rng() * cfg.map.h };
      if (!largest) return p;
      if (dist(p, largest.position) >= cfg.revive.minDistanceFromLargest) return p;
    }
    // 兜底：地图对角
    return largest
      ? { x: cfg.map.w - largest.position.x, y: cfg.map.h - largest.position.y }
      : { x: cfg.map.w / 2, y: cfg.map.h / 2 };
  };

  const spawnBallFor = (agentState: AgentState, time: number, tick: number) => {
    const id = makeBallId();
    const pos = findSpawnPoint(time);
    const ball: Ball = {
      id,
      agentId: agentState.agentId,
      position: pos,
      velocity: { x: 0, y: 0 },
      mass: cfg.initialMass,
      alive: true,
      burstUntil: 0,
      burstCooldownUntil: 0,
      invulnUntil: time + cfg.revive.invulnSeconds,
      spawnedAt: time,
    };
    balls.set(id, ball);
    agentState.ballId = id;
    agentState.activeThreats.clear();
    events.push({
      time,
      tick,
      type: "spawn",
      agentId: agentState.agentId,
      ballId: id,
      position: pos,
      livesRemaining: agentState.livesRemaining,
    });
  };

  // 第一次 spawn
  for (const state of agents.values()) {
    spawnBallFor(state, 0, 0);
  }

  // ---------- 主循环 ----------
  let lastStandingSince: { agentId: string; time: number } | null = null;
  let endReason: "last-standing" | "timeout" | "all-dead" | null = null;
  let winnerAgentId: string | undefined;

  for (let tick = 0; tick < totalTicks; tick++) {
    const time = tick * tickDt;

    // 1. 复活检查
    //    "3 次复活机会" = 1 条初始命 + 3 次复活 = 总共 4 条命
    //    所以：初始 spawn 不消耗 livesRemaining，每次"死后复活"消耗 1
    for (const state of agents.values()) {
      if (state.ballId && balls.get(state.ballId)?.alive) continue;
      if (state.livesRemaining <= 0) continue;
      if (time < state.deathPendingUntil) continue;
      // 这是一次复活（不是首次 spawn），消耗一次复活机会
      state.livesRemaining -= 1;
      spawnBallFor(state, time, tick);
    }

    // 2. 决策（每 N tick 一次）
    if (tick % decisionEveryNTick === 0) {
      runDecisions(agents, balls, bursts, foods, cfg, time, tick, events, latestDecisions);
    }

    // 3. 物理推进
    advancePhysics(balls, cfg, tickDt, time);

    // 4. burst 残影老化
    for (let i = bursts.length - 1; i >= 0; i--) {
      if (time - bursts[i].bornAt > 1.0) bursts.splice(i, 1);
    }

    // 5. 营养块吸收
    for (const ball of balls.values()) {
      if (!ball.alive) continue;
      const r = radiusOf(ball.mass);
      for (const food of [...foods.values()]) {
        if (dist2(ball.position, food.position) < r * r) {
          ball.mass += food.mass;
          foods.delete(food.id);
          const st = agents.get(ball.agentId)!;
          st.cumulativeFoodMass += food.mass;
          events.push({
            time, tick,
            type: "food-pickup",
            agentId: ball.agentId,
            mass: food.mass,
          });
        }
      }
    }

    // 6. 球-球吞噬
    resolveBallEats(balls, agents, cfg, time, tick, events);

    // 7. 营养块再生
    while (sumFoodMass(foods) < targetFoodMass) spawnFood();

    // 8. 危险接近 + 综合分增量
    accumulateDangerAndScore(agents, balls, cfg, time, tick, tickDt, events);

    // 9. 录帧（10Hz 录一次，省空间）
    if (tick % decisionEveryNTick === 0) {
      frames.push(snapshot(tick, time, balls, foods, bursts, latestDecisions));
    }

    // 10. 胜负检查
    const aliveAgents = aliveAgentIds(agents, balls);
    if (aliveAgents.length <= 1 && totalLivesLeft(agents, balls) <= 1) {
      const sole = aliveAgents[0];
      if (sole) {
        if (!lastStandingSince || lastStandingSince.agentId !== sole) {
          lastStandingSince = { agentId: sole, time };
        } else if (time - lastStandingSince.time >= cfg.lastStandingHoldSeconds) {
          endReason = "last-standing";
          winnerAgentId = sole;
          break;
        }
      } else {
        endReason = "all-dead";
        break;
      }
    } else {
      lastStandingSince = null;
    }
  }

  if (!endReason) endReason = "timeout";

  const finalTime = endReason === "last-standing"
    ? (lastStandingSince?.time ?? cfg.durationSeconds) + cfg.lastStandingHoldSeconds
    : cfg.durationSeconds;

  events.push({
    time: finalTime,
    tick: Math.floor(finalTime * cfg.tickRate),
    type: "game-end",
    reason: endReason,
    winnerAgentId,
  });

  // ---------- 结算 ----------
  const results = computeResults(agents, balls, cfg, finalTime, winnerAgentId);

  return {
    matchId,
    seed: cfg.seed,
    config: cfg,
    frames,
    events,
    results,
  };
}

// ---------------------------------------------------------------------------
// 子流程
// ---------------------------------------------------------------------------

function sumFoodMass(foods: Map<string, Food>): number {
  let s = 0;
  for (const f of foods.values()) s += f.mass;
  return s;
}

function largestAliveBall(balls: Map<string, Ball>): Ball | undefined {
  let best: Ball | undefined;
  for (const b of balls.values()) {
    if (!b.alive) continue;
    if (!best || b.mass > best.mass) best = b;
  }
  return best;
}

function aliveAgentIds(agents: Map<string, AgentState>, balls: Map<string, Ball>): string[] {
  const out: string[] = [];
  for (const st of agents.values()) {
    const b = st.ballId ? balls.get(st.ballId) : undefined;
    if (b?.alive) out.push(st.agentId);
  }
  return out;
}

function totalLivesLeft(agents: Map<string, AgentState>, balls: Map<string, Ball>): number {
  let n = 0;
  for (const st of agents.values()) {
    const b = st.ballId ? balls.get(st.ballId) : undefined;
    if (b?.alive) n++;
    n += st.livesRemaining;
  }
  return n;
}

function runDecisions(
  agents: Map<string, AgentState>,
  balls: Map<string, Ball>,
  bursts: Burst[],
  foods: Map<string, Food>,
  cfg: MatchConfig,
  time: number,
  tick: number,
  events: Event[],
  latestDecisions: Map<string, DecisionTrace>,
) {
  for (const state of agents.values()) {
    const ball = state.ballId ? balls.get(state.ballId) : undefined;
    if (!ball?.alive) continue;

    const meView = buildSelfView(ball, state, cfg, time);
    const worldView = buildWorldView(ball, state, agents, balls, bursts, foods, cfg, time, tick);

    let action: Action;
    const t0 = performance.now();
    try {
      action = state.strategy(meView, worldView);
      action = normalizeAction(action, state, cfg, time, tick, events);
    } catch (err) {
      state.decisionErrors++;
      events.push({
        time, tick,
        type: "decision-error",
        agentId: state.agentId,
        message: err instanceof Error ? err.message : String(err),
      });
      action = { type: "idle" };
    }
    const elapsed = performance.now() - t0;
    if (elapsed > 3) {
      state.decisionErrors++;
      events.push({
        time, tick,
        type: "decision-error",
        agentId: state.agentId,
        message: `decision exceeded 3ms: ${elapsed.toFixed(2)}ms`,
      });
      action = { type: "idle" };
    }

    latestDecisions.set(state.agentId, explainDecision(state.agentId, action, meView, worldView));
    applyAction(action, ball, state, bursts, cfg, time, tick, events);
  }
}

function explainDecision(agentId: string, action: Action, me: SelfView, world: WorldView): DecisionTrace {
  const threat = nearestVisibleThreat(me, world);
  const prey = nearestVisiblePrey(me, world);
  const food = bestVisibleFood(me, world);
  const threatDistance = threat ? dist(me.position, threat.position) : Infinity;
  const risk: DecisionTrace["risk"] = threatDistance < Math.max(me.radius * 3.5, 120)
    ? "危险"
    : threatDistance < Math.max(me.radius * 6, 220)
      ? "注意"
      : "安全";

  if (action.type === "burst") {
    const directionTarget = {
      x: me.position.x + action.direction.dx * 240,
      y: me.position.y + action.direction.dy * 240,
    };
    const movingTowardThreat = threat ? dist(directionTarget, threat.position) < threatDistance : false;
    const movingTowardPrey = prey ? dist(directionTarget, prey.position) < dist(me.position, prey.position) : false;
    return {
      agentId,
      action: "burst",
      focus: movingTowardPrey ? "追击窗口" : movingTowardThreat ? "危险脱离" : "速度窗口",
      risk,
      reason: movingTowardPrey
        ? "发现可吞噬目标进入冲刺距离，使用短冲抢先贴近。"
        : movingTowardThreat
          ? "附近大球压迫距离过近，使用短冲拉开安全半径。"
          : "当前质量和冷却允许冲刺，用速度换位置优势。",
      target: directionTarget,
    };
  }

  if (action.type === "move") {
    const target = action.target;
    const targetMovesAwayFromThreat = threat ? dist(target, threat.position) > threatDistance : false;
    const targetNearFood = food ? dist(target, food.position) < Math.max(90, me.radius * 3) : false;
    const targetNearPrey = prey ? dist(target, prey.position) < Math.max(120, me.radius * 4) : false;
    const center = { x: world.mapBounds.w / 2, y: world.mapBounds.h / 2 };
    const targetNearCenter = dist(target, center) < world.viewRadius * 0.45;

    if (risk !== "安全" && targetMovesAwayFromThreat) {
      return {
        agentId,
        action: "move",
        focus: "远离大球",
        risk,
        reason: "检测到更大球接近，移动目标能扩大与威胁的距离。",
        target,
      };
    }
    if (targetNearPrey) {
      return {
        agentId,
        action: "move",
        focus: "追击小球",
        risk,
        reason: "视野内存在质量明显更低的目标，尝试压近吞噬距离。",
        target,
      };
    }
    if (targetNearFood) {
      return {
        agentId,
        action: "move",
        focus: "收集营养",
        risk,
        reason: "当前安全窗口可用，优先靠近视野内收益更高的营养块。",
        target,
      };
    }
    if (targetNearCenter) {
      return {
        agentId,
        action: "move",
        focus: "中心控场",
        risk,
        reason: "附近没有立即威胁，向资源更密集的中心区域靠拢。",
        target,
      };
    }
    return {
      agentId,
      action: "move",
      focus: risk === "安全" ? "位置调整" : "安全转移",
      risk,
      reason: risk === "安全" ? "按当前托管策略调整站位，寻找下一段收益路线。" : "保留距离，避免被更大球夹住。",
      target,
    };
  }

  return {
    agentId,
    action: "idle",
    focus: "保持惯性",
    risk,
    reason: "当前没有更优目标或策略返回空动作，沿用上一移动目标。",
  };
}

function buildSelfView(ball: Ball, state: AgentState, cfg: MatchConfig, time: number): SelfView {
  return {
    id: ball.id,
    position: { ...ball.position },
    velocity: { ...ball.velocity },
    radius: radiusOf(ball.mass),
    mass: ball.mass,
    maxSpeed: speedOf(cfg, ball.mass),
    livesRemaining: state.livesRemaining + 1, // 含当前这条命
    burstCooldown: Math.max(0, ball.burstCooldownUntil - time),
    invulnUntil: ball.invulnUntil,
    score: state.cumulativeScore,
    survivalTime: time - ball.spawnedAt,
  };
}

function normalizeAction(
  action: Action,
  state: AgentState,
  cfg: MatchConfig,
  time: number,
  tick: number,
  events: Event[],
): Action {
  if (!action || typeof action !== "object") return { type: "idle" };
  if (action.type === "idle") return action;
  if (action.type === "move") {
    if (!isFinitePos(action.target)) {
      recordDecisionError(state, time, tick, events, "invalid move target");
      return { type: "idle" };
    }
    return {
      type: "move",
      target: clampToMap(action.target, cfg.map),
    };
  }
  if (action.type === "burst") {
    const { direction } = action;
    if (!direction || !Number.isFinite(direction.dx) || !Number.isFinite(direction.dy)) {
      recordDecisionError(state, time, tick, events, "invalid burst direction");
      return { type: "idle" };
    }
    return action;
  }
  recordDecisionError(state, time, tick, events, `unknown action type: ${String((action as { type?: unknown }).type)}`);
  return { type: "idle" };
}

function isFinitePos(p: Pos | undefined): p is Pos {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

function clampToMap(p: Pos, b: { w: number; h: number }): Pos {
  return {
    x: Math.max(0, Math.min(b.w, p.x)),
    y: Math.max(0, Math.min(b.h, p.y)),
  };
}

function recordDecisionError(
  state: AgentState,
  time: number,
  tick: number,
  events: Event[],
  message: string,
) {
  state.decisionErrors++;
  events.push({
    time,
    tick,
    type: "decision-error",
    agentId: state.agentId,
    message,
  });
}

function buildWorldView(
  ball: Ball,
  state: AgentState,
  agents: Map<string, AgentState>,
  balls: Map<string, Ball>,
  bursts: Burst[],
  foods: Map<string, Food>,
  cfg: MatchConfig,
  time: number,
  tick: number,
): WorldView {
  const viewR = viewRadiusOf(cfg, radiusOf(ball.mass));
  const vr2 = viewR * viewR;

  const visibleFoods: FoodView[] = [];
  for (const f of foods.values()) {
    if (dist2(ball.position, f.position) <= vr2) {
      visibleFoods.push({ id: f.id, position: { ...f.position }, mass: f.mass });
    }
  }

  const visibleEnemies: EnemyView[] = [];
  for (const other of balls.values()) {
    if (!other.alive) continue;
    if (other.id === ball.id) continue;
    if (dist2(ball.position, other.position) > vr2) continue;
    const otherState = agents.get(other.agentId)!;
    visibleEnemies.push({
      id: other.id,
      agentId: other.agentId,
      position: { ...other.position },
      velocity: { ...other.velocity },
      radius: radiusOf(other.mass),
      mass: other.mass,
      livesRemaining: otherState.livesRemaining + 1,
      invulnerable: time < other.invulnUntil,
    });
  }

  const visibleBursts: BurstView[] = [];
  for (const b of bursts) {
    if (dist2(ball.position, b.position) > vr2) continue;
    visibleBursts.push({
      agentId: b.agentId,
      position: { ...b.position },
      direction: { dx: b.direction.x, dy: b.direction.y },
      ageSeconds: time - b.bornAt,
    });
  }

  const sorted = [...agents.values()]
    .map((s) => ({ s, alive: s.ballId ? balls.get(s.ballId)?.alive ?? false : false }))
    .sort((a, b) => b.s.cumulativeScore - a.s.cumulativeScore);
  const rankings = sorted.map((row, i) => ({
    agentId: row.s.agentId,
    name: row.s.name,
    rank: i + 1,
    score: row.s.cumulativeScore,
    alive: row.alive,
  }));

  return {
    tick,
    time,
    timeRemaining: cfg.durationSeconds - time,
    viewRadius: viewR,
    mapBounds: { ...cfg.map },
    foods: visibleFoods,
    enemies: visibleEnemies,
    bursts: visibleBursts,
    rankings,
  };
}

function applyAction(
  action: Action,
  ball: Ball,
  state: AgentState,
  bursts: Burst[],
  cfg: MatchConfig,
  time: number,
  tick: number,
  events: Event[],
) {
  if (action.type === "move") {
    ball.moveTarget = { x: action.target.x, y: action.target.y };
  } else if (action.type === "burst") {
    const canBurst =
      time >= ball.burstCooldownUntil && ball.mass >= cfg.initialMass * cfg.burst.minMassRatio;
    if (!canBurst) {
      state.decisionErrors++;
      events.push({
        time, tick,
        type: "decision-error",
        agentId: state.agentId,
        message: `burst denied: cooldown=${(ball.burstCooldownUntil - time).toFixed(2)}s mass=${ball.mass.toFixed(1)}`,
      });
      return;
    }
    // 归一化
    let dx = action.direction.dx;
    let dy = action.direction.dy;
    const mag = Math.hypot(dx, dy);
    if (mag < 1e-6) return;
    dx /= mag;
    dy /= mag;
    const cost = ball.mass * cfg.burst.massCostRatio;
    ball.mass -= cost;
    ball.burstDir = { x: dx, y: dy };
    ball.burstUntil = time + cfg.burst.durationSeconds;
    ball.burstCooldownUntil = time + cfg.burst.cooldownSeconds;
    state.burstsTotal++;
    state.lastBurstAt = time;
    bursts.push({
      agentId: ball.agentId,
      position: { ...ball.position },
      direction: { x: dx, y: dy },
      bornAt: time,
    });
    events.push({
      time, tick,
      type: "burst",
      agentId: ball.agentId,
      ballId: ball.id,
      direction: { dx, dy },
      cost,
    });
  }
  // idle: 保持上一次目标
}

function advancePhysics(balls: Map<string, Ball>, cfg: MatchConfig, dt: number, time: number) {
  for (const ball of balls.values()) {
    if (!ball.alive) continue;

    let speedCap = speedOf(cfg, ball.mass);
    let dirX = 0;
    let dirY = 0;

    if (time < ball.burstUntil && ball.burstDir) {
      speedCap *= cfg.burst.speedMultiplier;
      dirX = ball.burstDir.x;
      dirY = ball.burstDir.y;
    } else if (ball.moveTarget) {
      const dx = ball.moveTarget.x - ball.position.x;
      const dy = ball.moveTarget.y - ball.position.y;
      const d = Math.hypot(dx, dy);
      if (d > 1e-3) {
        dirX = dx / d;
        dirY = dy / d;
      }
    }

    // 平滑：当前速度向目标速度靠拢
    const targetVx = dirX * speedCap;
    const targetVy = dirY * speedCap;
    const accel = 0.35; // 单帧靠拢比例
    ball.velocity.x += (targetVx - ball.velocity.x) * accel;
    ball.velocity.y += (targetVy - ball.velocity.y) * accel;

    ball.position.x += ball.velocity.x * dt;
    ball.position.y += ball.velocity.y * dt;

    // 边界
    const r = radiusOf(ball.mass);
    if (ball.position.x < r) {
      ball.position.x = r;
      ball.velocity.x *= -0.3;
    } else if (ball.position.x > cfg.map.w - r) {
      ball.position.x = cfg.map.w - r;
      ball.velocity.x *= -0.3;
    }
    if (ball.position.y < r) {
      ball.position.y = r;
      ball.velocity.y *= -0.3;
    } else if (ball.position.y > cfg.map.h - r) {
      ball.position.y = cfg.map.h - r;
      ball.velocity.y *= -0.3;
    }
  }
}

function resolveBallEats(
  balls: Map<string, Ball>,
  agents: Map<string, AgentState>,
  cfg: MatchConfig,
  time: number,
  tick: number,
  events: Event[],
) {
  const alive = [...balls.values()].filter((b) => b.alive);
  for (const a of alive) {
    if (!a.alive) continue;
    const rA = radiusOf(a.mass);
    for (const b of alive) {
      if (!b.alive || b === a) continue;
      if (time < a.invulnUntil || time < b.invulnUntil) continue;
      if (a.mass < b.mass * cfg.eatRatio) continue;
      if (dist2(a.position, b.position) > rA * rA) continue;

      // a 吃掉 b
      a.mass += b.mass;
      b.alive = false;
      const killerState = agents.get(a.agentId)!;
      const victimState = agents.get(b.agentId)!;
      killerState.kills++;
      if (time - killerState.lastBurstAt <= 2.0) {
        markBurstEffective(killerState, tick);
      }
      victimState.deaths++;
      // livesRemaining 在"复活"那一刻才扣，死亡只标记死亡 + 设置复活冷却
      victimState.deathPendingUntil = time + cfg.revive.cooldownSeconds;
      events.push({
        time, tick,
        type: "kill",
        killerId: a.id,
        killerAgentId: a.agentId,
        victimId: b.id,
        victimAgentId: b.agentId,
        massGained: b.mass,
      });
      events.push({
        time, tick,
        type: "death",
        agentId: b.agentId,
        ballId: b.id,
        killerId: a.id,
        killerAgentId: a.agentId,
        reason: "eaten",
      });
    }
  }
}

function accumulateDangerAndScore(
  agents: Map<string, AgentState>,
  balls: Map<string, Ball>,
  cfg: MatchConfig,
  time: number,
  tick: number,
  dt: number,
  events: Event[],
) {
  for (const state of agents.values()) {
    const ball = state.ballId ? balls.get(state.ballId) : undefined;
    if (!ball?.alive) continue;

    state.cumulativeSurvival += dt;

    const r = radiusOf(ball.mass);
    const dangerR = r * 2.5;
    const dangerR2 = dangerR * dangerR;
    const currentThreats = new Set<string>();
    for (const other of balls.values()) {
      if (!other.alive || other.id === ball.id) continue;
      if (other.mass < ball.mass * cfg.eatRatio) continue;
      if (dist2(ball.position, other.position) <= dangerR2) {
        currentThreats.add(other.agentId);
      }
    }

    // 新增 / 离开
    for (const t of currentThreats) {
      if (!state.activeThreats.has(t)) {
        events.push({
          time, tick,
          type: "danger-enter",
          agentId: state.agentId,
          threatAgentId: t,
        });
      }
    }
    for (const t of state.activeThreats) {
      if (!currentThreats.has(t)) {
        events.push({
          time, tick,
          type: "danger-exit",
          agentId: state.agentId,
          threatAgentId: t,
        });
        // burst-saved 简化判定：刚 burst 完 1 秒内脱离
        if (time - state.lastBurstAt < 1.5) {
          markBurstEffective(state, tick);
          events.push({
            time, tick,
            type: "burst-saved",
            agentId: state.agentId,
            almostKilledBy: t,
          });
        }
      }
    }
    if (currentThreats.size > 0) state.dangerSeconds += dt;
    state.activeThreats = currentThreats;

    // burst-effective 第二种：burst 后 2 秒内有 kill 已在 resolveBallEats 时统计
  }
}

function markBurstEffective(state: AgentState, tick: number) {
  if (state.effectiveBurstTicks.has(tick)) return;
  state.effectiveBurstTicks.add(tick);
  state.burstsEffective++;
}

function snapshot(
  tick: number,
  time: number,
  balls: Map<string, Ball>,
  foods: Map<string, Food>,
  bursts: Burst[],
  latestDecisions: Map<string, DecisionTrace>,
): ReplayFrame {
  const liveAgentIds = new Set([...balls.values()].filter((b) => b.alive).map((b) => b.agentId));
  return {
    tick,
    time,
    balls: [...balls.values()].filter((b) => b.alive).map((b) => ({
      id: b.id,
      agentId: b.agentId,
      position: { ...b.position },
      radius: radiusOf(b.mass),
      mass: b.mass,
      velocity: { ...b.velocity },
      invulnerable: time < b.invulnUntil,
    })),
    foods: [...foods.values()].map((f) => ({ id: f.id, position: { ...f.position }, mass: f.mass })),
    bursts: bursts.map((b) => ({
      agentId: b.agentId,
      position: { ...b.position },
      direction: { dx: b.direction.x, dy: b.direction.y },
      ageSeconds: time - b.bornAt,
    })),
    decisions: [...latestDecisions.values()].filter((decision) => liveAgentIds.has(decision.agentId)),
  };
}

function nearestVisibleThreat(me: SelfView, world: WorldView): EnemyView | undefined {
  return world.enemies
    .filter((enemy) => !enemy.invulnerable && enemy.mass >= me.mass * 1.15)
    .sort((a, b) => dist(me.position, a.position) - dist(me.position, b.position))[0];
}

function nearestVisiblePrey(me: SelfView, world: WorldView): EnemyView | undefined {
  return world.enemies
    .filter((enemy) => !enemy.invulnerable && enemy.mass <= me.mass * 0.72)
    .sort((a, b) => dist(me.position, a.position) - dist(me.position, b.position))[0];
}

function bestVisibleFood(me: SelfView, world: WorldView): FoodView | undefined {
  return world.foods
    .map((food) => ({
      food,
      score: food.mass * 10 - dist(me.position, food.position) * 0.045,
    }))
    .sort((a, b) => b.score - a.score)[0]?.food;
}

function computeResults(
  agents: Map<string, AgentState>,
  balls: Map<string, Ball>,
  cfg: MatchConfig,
  finalTime: number,
  winnerAgentId: string | undefined,
): MatchResult[] {
  const rows: MatchResult[] = [];
  for (const state of agents.values()) {
    const ball = state.ballId ? balls.get(state.ballId) : undefined;
    const finalMass = ball?.alive ? ball.mass : 0;
    const score = Math.max(
      0,
      finalMass * cfg.scoring.massWeight +
        state.kills * cfg.scoring.killWeight +
        state.cumulativeSurvival * cfg.scoring.survivalSecondWeight +
        state.livesRemaining * cfg.scoring.remainingLifeWeight -
        state.dangerSeconds * cfg.scoring.dangerSecondPenalty
    );
    const metrics: MatchMetrics = {
      agentId: state.agentId,
      finalRank: 0,
      finalMass,
      kills: state.kills,
      deaths: state.deaths,
      survivalTime: state.cumulativeSurvival,
      foodPickedMass: state.cumulativeFoodMass,
      burstsTotal: state.burstsTotal,
      burstsEffective: state.burstsEffective,
      dangerSeconds: state.dangerSeconds,
      decisionErrors: state.decisionErrors,
      score,
      eloDelta: 0, // 在排程器层算
    };
    rows.push({
      agentId: state.agentId,
      name: state.name,
      rank: 0,
      score,
      alive: !!ball?.alive,
      livesUsed: cfg.revive.maxLives - state.livesRemaining,
      metrics,
    });
  }

  // 排名：胜者最前，其余按 score
  rows.sort((a, b) => {
    if (winnerAgentId) {
      if (a.agentId === winnerAgentId) return -1;
      if (b.agentId === winnerAgentId) return 1;
    }
    return b.score - a.score;
  });
  rows.forEach((r, i) => {
    r.rank = i + 1;
    r.metrics.finalRank = i + 1;
  });

  return rows;
}
