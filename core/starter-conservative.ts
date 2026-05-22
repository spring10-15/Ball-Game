/**
 * starter-conservative.ts
 *
 * 一个"保守型"球球策略示例。
 *
 * 风格：优先远离比自己大 15% 以上的对手；在安全前提下吃营养块；
 *      只有在追击高把握 prey 时才用 burst；从不深入对手密集区。
 *
 * coding agent 可以把它当作起点，逐步替换威胁评估、机会评估、
 * burst 触发条件三块来塑造自己的风格。
 */

import type { Action, EnemyView, FoodView, Pos, SelfView, WorldView } from "./types.js";

const EAT_RATIO = 1.15;

export default function onTick(me: SelfView, world: WorldView): Action {
  // --- 1. 威胁评估 -------------------------------------------------------
  const threats = world.enemies.filter((e) => !e.invulnerable && e.mass >= me.mass * EAT_RATIO);
  const nearestThreat = nearestEntity(me.position, threats);
  const threatDist = nearestThreat ? distance(me.position, nearestThreat.position) : Infinity;

  // 迫近危险：威胁在 4 倍自身半径内
  const inDanger = nearestThreat && threatDist < me.radius * 4;

  // --- 2. 紧急逃命 -------------------------------------------------------
  if (inDanger && nearestThreat) {
    const fleeDir = unitFrom(nearestThreat.position, me.position);

    // 能 burst 就 burst，否则正常逃
    if (me.burstCooldown === 0 && me.mass > 24 /* 初始 20 × 1.2 */) {
      return { type: "burst", direction: { dx: fleeDir.dx, dy: fleeDir.dy } };
    }
    const fleeTarget = clampToMap(
      {
        x: me.position.x + fleeDir.dx * 800,
        y: me.position.y + fleeDir.dy * 800,
      },
      world.mapBounds,
    );
    return { type: "move", target: fleeTarget };
  }

  // --- 3. 机会评估 -------------------------------------------------------
  const prey = world.enemies.filter(
    (e) => !e.invulnerable && e.mass * EAT_RATIO <= me.mass,
  );

  // 选最大、且离我足够近、且远离任何威胁的猎物
  const tastyPrey = prey
    .filter((p) => !threatNearby(p.position, threats, p.radius * 6))
    .sort((a, b) => b.mass - a.mass)[0];

  // burst 抓 prey 的条件：距离适中、burst 就绪、prey 比我小够多
  if (tastyPrey && me.burstCooldown === 0 && me.mass > 24) {
    const d = distance(me.position, tastyPrey.position);
    if (d > me.radius * 2 && d < me.radius * 6 && tastyPrey.mass < me.mass * 0.8) {
      const dir = unitFrom(me.position, tastyPrey.position);
      return { type: "burst", direction: { dx: dir.dx, dy: dir.dy } };
    }
  }

  if (tastyPrey && distance(me.position, tastyPrey.position) < me.radius * 8) {
    return { type: "move", target: tastyPrey.position };
  }

  // --- 4. 没机会就吃营养块 -----------------------------------------------
  const safeFood = chooseSafeFood(me, world.foods, threats);
  if (safeFood) {
    return { type: "move", target: safeFood.position };
  }

  // --- 5. 实在没事干，往地图中心慢慢挪 -----------------------------------
  return {
    type: "move",
    target: { x: world.mapBounds.w / 2, y: world.mapBounds.h / 2 },
  };
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function distance(a: Pos, b: Pos): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function unitFrom(from: Pos, to: Pos): { dx: number; dy: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const m = Math.hypot(dx, dy) || 1;
  return { dx: dx / m, dy: dy / m };
}

function nearestEntity<T extends { position: Pos }>(p: Pos, xs: T[]): T | undefined {
  let best: T | undefined;
  let bestD = Infinity;
  for (const x of xs) {
    const d = distance(p, x.position);
    if (d < bestD) {
      best = x;
      bestD = d;
    }
  }
  return best;
}

function threatNearby(pos: Pos, threats: EnemyView[], radius: number): boolean {
  return threats.some((t) => distance(pos, t.position) < radius);
}

function chooseSafeFood(me: SelfView, foods: FoodView[], threats: EnemyView[]): FoodView | undefined {
  if (foods.length === 0) return undefined;
  // 给每块食物打分：质量越大越好，距离越近越好，附近有威胁直接淘汰
  let best: FoodView | undefined;
  let bestScore = -Infinity;
  for (const f of foods) {
    if (threats.some((t) => distance(t.position, f.position) < t.radius * 3)) continue;
    const d = Math.max(1, distance(me.position, f.position));
    const score = f.mass / d;
    if (score > bestScore) {
      best = f;
      bestScore = score;
    }
  }
  return best;
}

function clampToMap(p: Pos, b: { w: number; h: number }): Pos {
  return {
    x: Math.max(50, Math.min(b.w - 50, p.x)),
    y: Math.max(50, Math.min(b.h - 50, p.y)),
  };
}
