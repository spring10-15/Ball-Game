import { useEffect, useRef } from "react";

import type { Replay, ReplayFrame } from "../core/types";
import { displayAgentShortName, getAgentColor } from "./replay";

interface ReplayCanvasProps {
  replay: Replay;
  frame: ReplayFrame;
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string | null) => void;
  labelForAgent?: (agentId: string) => string;
  colorForAgent?: (agentId: string) => string;
}

export function ReplayCanvas({ replay, frame, selectedAgentId, onSelectAgent, labelForAgent, colorForAgent }: ReplayCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    context.setTransform(dpr, 0, 0, dpr, 0, 0);

    drawArena(context, rect.width, rect.height, replay, frame, selectedAgentId, labelForAgent, colorForAgent);
  }, [colorForAgent, frame, labelForAgent, replay, selectedAgentId]);

  function handleClick(event: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / replay.config.map.w, rect.height / replay.config.map.h);
    const offsetX = (rect.width - replay.config.map.w * scale) / 2;
    const offsetY = (rect.height - replay.config.map.h * scale) / 2;
    const x = (event.clientX - rect.left - offsetX) / scale;
    const y = (event.clientY - rect.top - offsetY) / scale;

    let selected: string | null = null;
    let selectedDistance = Infinity;
    for (const ball of frame.balls) {
      const d = Math.hypot(ball.position.x - x, ball.position.y - y);
      if (d <= ball.radius * 1.6 && d < selectedDistance) {
        selected = ball.agentId;
        selectedDistance = d;
      }
    }
    onSelectAgent(selected);
  }

  return (
    <canvas
      ref={canvasRef}
      className="replay-canvas"
      aria-label="回放地图"
      onClick={handleClick}
    />
  );
}

function drawArena(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  replay: Replay,
  frame: ReplayFrame,
  selectedAgentId: string | null,
  labelForAgent?: (agentId: string) => string,
  colorForAgent?: (agentId: string) => string,
) {
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#f8fafc";
  context.fillRect(0, 0, width, height);

  const { w, h } = replay.config.map;
  const scale = Math.min(width / w, height / h);
  const arenaW = w * scale;
  const arenaH = h * scale;
  const offsetX = (width - arenaW) / 2;
  const offsetY = (height - arenaH) / 2;

  context.save();
  context.translate(offsetX, offsetY);
  context.scale(scale, scale);

  drawGrid(context, w, h);
  drawFoods(context, frame, scale);
  drawBursts(context, frame);
  drawBalls(context, replay, frame, selectedAgentId, scale, labelForAgent, colorForAgent);

  context.lineWidth = 8;
  context.strokeStyle = "#0f172a";
  context.strokeRect(0, 0, w, h);

  context.restore();
}

function drawGrid(context: CanvasRenderingContext2D, w: number, h: number) {
  context.fillStyle = "#f8fafc";
  context.fillRect(0, 0, w, h);
  context.strokeStyle = "#cbd5e1";
  context.lineWidth = 3;
  for (let x = 500; x < w; x += 500) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, h);
    context.stroke();
  }
  for (let y = 500; y < h; y += 500) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(w, y);
    context.stroke();
  }
}

function drawFoods(context: CanvasRenderingContext2D, frame: ReplayFrame, scale: number) {
  for (const food of frame.foods) {
    const radius = Math.max(food.mass >= 20 ? 12 : food.mass >= 5 ? 7 : 4, 3 / scale);
    context.beginPath();
    context.fillStyle = food.mass >= 20 ? "#f59e0b" : food.mass >= 5 ? "#22c55e" : "#94a3b8";
    context.arc(food.position.x, food.position.y, radius, 0, Math.PI * 2);
    context.fill();
  }
}

function drawBursts(context: CanvasRenderingContext2D, frame: ReplayFrame) {
  context.lineCap = "round";
  for (const burst of frame.bursts) {
    const alpha = Math.max(0, 1 - burst.ageSeconds);
    context.strokeStyle = `rgba(15, 23, 42, ${alpha * 0.25})`;
    context.lineWidth = 18;
    context.beginPath();
    context.moveTo(burst.position.x, burst.position.y);
    context.lineTo(
      burst.position.x + burst.direction.dx * 120,
      burst.position.y + burst.direction.dy * 120,
    );
    context.stroke();
  }
}

function drawBalls(
  context: CanvasRenderingContext2D,
  replay: Replay,
  frame: ReplayFrame,
  selectedAgentId: string | null,
  scale: number,
  labelForAgent?: (agentId: string) => string,
  colorForAgent?: (agentId: string) => string,
) {
  const ordered = [...frame.balls].sort((a, b) => a.radius - b.radius);
  for (const ball of ordered) {
    const color = colorForAgent?.(ball.agentId) ?? getAgentColor(replay, ball.agentId);
    const isSelected = selectedAgentId === ball.agentId;
    const visualRadius = Math.max(ball.radius, 12 / scale);

    context.beginPath();
    context.fillStyle = color;
    context.globalAlpha = ball.invulnerable ? 0.62 : 0.92;
    context.arc(ball.position.x, ball.position.y, visualRadius, 0, Math.PI * 2);
    context.fill();
    context.globalAlpha = 1;

    context.lineWidth = isSelected ? 4 / scale : 3 / scale;
    context.strokeStyle = isSelected ? "#020617" : "rgba(255,255,255,0.85)";
    context.stroke();

    context.fillStyle = "#0f172a";
    context.font = `700 ${Math.max(42, 11 / scale)}px Inter, system-ui, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(shortLabel(labelForAgent?.(ball.agentId) ?? displayAgentShortName(ball.agentId)), ball.position.x, ball.position.y);
  }
}

function shortLabel(label: string): string {
  return label.length > 4 ? label.slice(0, 4) : label;
}
