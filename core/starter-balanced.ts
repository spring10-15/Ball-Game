/**
 * starter-balanced.ts
 *
 * 一个更适合做迭代基线的均衡型策略。
 *
 * 相比 conservative：
 * - 逃跑使用多个威胁的合力方向，不只看最近威胁。
 * - 食物评分同时考虑质量、距离、威胁距离和地图边界。
 * - 追击只在附近没有第三方大球时进行，burst 更克制。
 */

import type { Action, EnemyView, FoodView, Pos, SelfView, WorldView } from "./types.js";

const EAT_RATIO = 1.15;
const INITIAL_MASS = 20;
const BURST_READY_MASS = INITIAL_MASS * 1.2;

export default function onTick(me: SelfView, world: WorldView): Action {
  const threats = world.enemies.filter((e) => !e.invulnerable && e.mass >= me.mass * EAT_RATIO);
  const nearestThreat = nearest(me.position, threats);
  const nearestThreatDistance = nearestThreat ? distance(me.position, nearestThreat.position) : Infinity;
  const dangerDistance = Math.max(me.radius * 4.5, 120);

  if (nearestThreat && nearestThreatDistance < dangerDistance) {
    const flee = threatWeightedFleeDirection(me.position, threats);
    if (me.burstCooldown === 0 && me.mass >= BURST_READY_MASS && nearestThreatDistance < me.radius * 3.2) {
      return { type: "burst", direction: flee };
    }
    return {
      type: "move",
      target: clampToMap(
        {
          x: me.position.x + flee.dx * 900,
          y: me.position.y + flee.dy * 900,
        },
        world.mapBounds,
      ),
    };
  }

  const prey = choosePrey(me, world.enemies, threats);
  if (prey) {
    const preyDistance = distance(me.position, prey.position);
    if (
      me.burstCooldown === 0 &&
      me.mass >= BURST_READY_MASS &&
      prey.mass <= me.mass * 0.68 &&
      preyDistance > me.radius * 2.2 &&
      preyDistance < me.radius * 5.5
    ) {
      return { type: "burst", direction: unitFrom(me.position, prey.position) };
    }
    return { type: "move", target: leadTarget(prey, 0.5, world.mapBounds) };
  }

  const food = chooseFood(me, world.foods, threats, world.mapBounds);
  if (food) return { type: "move", target: food.position };

  return {
    type: "move",
    target: safeCenterDrift(me.position, threats, world.mapBounds),
  };
}

function choosePrey(me: SelfView, enemies: EnemyView[], threats: EnemyView[]): EnemyView | undefined {
  let best: EnemyView | undefined;
  let bestScore = -Infinity;
  for (const enemy of enemies) {
    if (enemy.invulnerable || enemy.mass * EAT_RATIO > me.mass) continue;
    const d = distance(me.position, enemy.position);
    if (d > me.radius * 9) continue;
    if (threats.some((t) => distance(t.position, enemy.position) < Math.max(t.radius * 5, 260))) continue;

    const score = enemy.mass * 2.4 - d * 0.08 - closingPenalty(me, enemy);
    if (score > bestScore) {
      best = enemy;
      bestScore = score;
    }
  }
  return best;
}

function chooseFood(
  me: SelfView,
  foods: FoodView[],
  threats: EnemyView[],
  bounds: { w: number; h: number },
): FoodView | undefined {
  let best: FoodView | undefined;
  let bestScore = -Infinity;
  for (const food of foods) {
    const d = Math.max(1, distance(me.position, food.position));
    const threatPenalty = threats.reduce((sum, threat) => {
      const td = distance(threat.position, food.position);
      const unsafeDistance = Math.max(threat.radius * 5, 240);
      return td < unsafeDistance ? sum + (unsafeDistance - td) * 0.08 : sum;
    }, 0);
    if (threatPenalty > 18) continue;

    const edgePenalty = edgeRisk(food.position, bounds) * 0.35;
    const score = food.mass * 7 - d * 0.035 - threatPenalty - edgePenalty;
    if (score > bestScore) {
      best = food;
      bestScore = score;
    }
  }
  return best;
}

function threatWeightedFleeDirection(from: Pos, threats: EnemyView[]): { dx: number; dy: number } {
  let dx = 0;
  let dy = 0;
  for (const threat of threats) {
    const away = unitFrom(threat.position, from);
    const d = Math.max(1, distance(from, threat.position));
    const weight = threat.mass / (d * d);
    dx += away.dx * weight;
    dy += away.dy * weight;
  }
  const mag = Math.hypot(dx, dy) || 1;
  return { dx: dx / mag, dy: dy / mag };
}

function closingPenalty(me: SelfView, enemy: EnemyView): number {
  const towardMe = unitFrom(enemy.position, me.position);
  const relativeVx = enemy.velocity.x - me.velocity.x;
  const relativeVy = enemy.velocity.y - me.velocity.y;
  return Math.max(0, relativeVx * towardMe.dx + relativeVy * towardMe.dy) * 0.04;
}

function leadTarget(enemy: EnemyView, seconds: number, bounds: { w: number; h: number }): Pos {
  return clampToMap(
    {
      x: enemy.position.x + enemy.velocity.x * seconds,
      y: enemy.position.y + enemy.velocity.y * seconds,
    },
    bounds,
  );
}

function safeCenterDrift(me: Pos, threats: EnemyView[], bounds: { w: number; h: number }): Pos {
  if (threats.length === 0) return { x: bounds.w / 2, y: bounds.h / 2 };
  const flee = threatWeightedFleeDirection(me, threats);
  return clampToMap({ x: me.x + flee.dx * 700, y: me.y + flee.dy * 700 }, bounds);
}

function nearest<T extends { position: Pos }>(p: Pos, xs: T[]): T | undefined {
  let best: T | undefined;
  let bestDistance = Infinity;
  for (const x of xs) {
    const d = distance(p, x.position);
    if (d < bestDistance) {
      best = x;
      bestDistance = d;
    }
  }
  return best;
}

function distance(a: Pos, b: Pos): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function unitFrom(from: Pos, to: Pos): { dx: number; dy: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const mag = Math.hypot(dx, dy) || 1;
  return { dx: dx / mag, dy: dy / mag };
}

function edgeRisk(p: Pos, b: { w: number; h: number }): number {
  return Math.max(0, 220 - Math.min(p.x, p.y, b.w - p.x, b.h - p.y));
}

function clampToMap(p: Pos, b: { w: number; h: number }): Pos {
  return {
    x: Math.max(40, Math.min(b.w - 40, p.x)),
    y: Math.max(40, Math.min(b.h - 40, p.y)),
  };
}
