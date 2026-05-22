/**
 * starter-greedy.ts
 *
 * 一个"贪婪型"对手，用来与保守型 starter 互相对照。
 * 风格：永远朝最近的食物或最大的可吃猎物冲；burst 一上来就用。
 *
 * 它会经常死，但能逼保守型策略证明自己。
 */

import type { Action, SelfView, WorldView, Pos } from "./types.js";

const EAT_RATIO = 1.15;

export default function onTick(me: SelfView, world: WorldView): Action {
  const prey = world.enemies.filter((e) => !e.invulnerable && e.mass * EAT_RATIO <= me.mass);
  const biggestPrey = prey.sort((a, b) => b.mass - a.mass)[0];

  if (biggestPrey && me.burstCooldown === 0 && me.mass > 24) {
    const dir = unitFrom(me.position, biggestPrey.position);
    return { type: "burst", direction: { dx: dir.dx, dy: dir.dy } };
  }
  if (biggestPrey) {
    return { type: "move", target: biggestPrey.position };
  }

  const nearestFood = world.foods.sort(
    (a, b) => distance(me.position, a.position) - distance(me.position, b.position),
  )[0];
  if (nearestFood) return { type: "move", target: nearestFood.position };

  return { type: "move", target: { x: world.mapBounds.w / 2, y: world.mapBounds.h / 2 } };
}

function distance(a: Pos, b: Pos) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function unitFrom(from: Pos, to: Pos) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const m = Math.hypot(dx, dy) || 1;
  return { dx: dx / m, dy: dy / m };
}
