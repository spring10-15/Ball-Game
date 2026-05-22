# Agent 球球大作战 · v0 设计规范

> 这份文档是后续所有产物（SDK、模拟器、API、Agent Guide、starter 策略、前端观看器）的源头。
> 任何代码 / 文档与本文档冲突时，以本文档为准；本文档要变更，必须同步更新所有下游产物。

---

## 0. 一句话产品定义

> 一个让用户把 agent_key 交给 coding agent，由 coding agent 持续读状态、改策略、跑模拟、发版本、参加 round-robin 竞技的网页游戏。
> 网页只给人看战绩、回放、排行榜；agent 的全部操作走 API / CLI。

---

## 1. 整体闭环

```text
人创建 agent
    -> 拿到 agent_id + agent_key + Agent Guide 链接
    -> 把 key 和 Guide 交给 coding agent
    -> coding agent 读状态、读 replay、改策略
    -> 本地 simulate 验证
    -> publish 新版本
    -> 后端排程 round-robin 对战，产出 replay 和综合分
    -> 排行榜更新 ELO
    -> 人在网页上看 replay 和排名，反馈给 coding agent
    -> 继续迭代
```

---

## 2. 游戏规则

### 2.1 基本机制

- 地图：固定矩形，4000 × 4000 单位（无环形回绕）。
- 营养块：随机位置刷新，大小不一，被碰撞即吸收。
- 玩家：每个 agent 控制一个球，吃营养块或体积差足够大的对手变大。
- 大球吞小球：当 `mass_self ≥ mass_other × 1.15` 且圆心距离 < `r_self` 时触发吞噬。
- 速度随质量变化：`speed = baseSpeed / sqrt(mass / initialMass)`，质量越大越慢。

### 2.2 玩家动作集（v0 只有两个）

| 动作 | 字段 | 语义 |
|---|---|---|
| `move` | `{ x, y }` 目标坐标 | 朝目标方向加速移动；每次决策可改方向 |
| `burst` | `{ dx, dy }` 单位方向向量 | 朝该方向短时加速；消耗自身质量；有冷却 |

`burst` 参数：

| 项 | 值 |
|---|---|
| 触发消耗 | 自身质量 × 8%（直接消失，不变成营养块） |
| 加速效果 | 当前速度上限 × 2.2，持续 1.2 秒 |
| 冷却 | 8 秒（从触发时刻计） |
| 最小质量门槛 | 初始质量 × 1.2（太小不能用） |

**没有分裂、没有合体、没有喷射成可吃营养块。** 策略空间完全押在"走位 + burst 时机 + 视野利用"。

### 2.3 复活机制

- 每个 agent 单局有 **3 次复活机会**。
- 死亡后 5 秒冷却，然后在"远离当前最大球至少 1500 单位"的随机位置刷新。
- 复活后体积回到 **初始质量**（不继承死前质量）。
- 复活后 2 秒"无敌帧"：不可被吞噬，也不可吞噬别人。
- 剩余复活次数计入综合分。
- 用完 3 次后再死 → 退出本局。

### 2.4 视野

- 视野半径 `view_radius = clamp(自身半径 × 8, 800, 2000)`。
- 视野是圆形 fog of war，超出视野的对手 / 营养块 / 障碍**完全不可见**。
- 视野信息以 agent 自身为圆心，每次决策刷新。
- 视野中可见的实体：营养块、其他 agent 的球、burst 效果残影（1 秒内可见）、地图边界。

### 2.5 营养块

- 总量上限 ≈ 全场玩家初始总质量 × 4。
- 按密度上限自动刷新：每秒补满到上限。
- 营养块质量分布：80% 是小块（质量 1），15% 中块（质量 5），5% 大块（质量 20）。
- 营养块在地图上均匀随机分布，不刻意避开玩家。

### 2.6 物理与决策频率

| 项 | 值 |
|---|---|
| 模拟 tick 频率 | 30 Hz |
| 策略决策频率 | 10 Hz（每 3 tick 调用一次 `onTick`） |
| 决策间运动 | 沿上次返回方向继续插值 |
| 策略 CPU 预算 | 3 ms / 决策（超时降级为 `idle`） |
| 策略内存预算 | 8 MB（隔离 isolate） |
| 单局最长时长 | 5 分钟（300 秒） |

### 2.7 胜负规则

按优先级判定：

1. **正常胜利**：场上仅剩一个 agent 存活，且持续存活 10 秒以上 → 该 agent 获胜，单局结束。
2. **时间兜底**：5 分钟内未分出"最后一人" → 按综合分排名结算。
3. **同时灭团**：罕见情况，所有剩余 agent 同 tick 死光 → 按综合分排名结算。

---

## 3. 评分

### 3.1 综合分公式（v0）

```text
综合分 = 最终体积 × 1.0
       + 击杀数 × 50
       + 存活时间(秒) × 0.5
       + 剩余复活次数 × 100
       - 危险接近惩罚（被大球贴近 < 安全距离的累积秒数 × 2）
```

- "危险接近"：视野内存在 `mass_other ≥ mass_self × 1.15` 的球且距离 < `自身半径 × 2.5` 的时段。
- 综合分不允许为负，最低截断 0。

### 3.2 ELO

- 单局结束后，按"名次"两两配对计算 ELO 变化。
- 初始 ELO = 1200，K 因子 = 24。
- 排行榜按 ELO 排序，平分时按近 30 局综合分均值排序。

---

## 4. 数据结构

完整 TypeScript 定义见 `core/types.ts`，这里只列字段语义。

### 4.1 `SelfView`（agent 自身视图）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | agent 球 id |
| `position` | `{x,y}` | 当前圆心坐标 |
| `velocity` | `{x,y}` | 当前速度向量 |
| `radius` | number | 当前半径 |
| `mass` | number | 当前质量 |
| `maxSpeed` | number | 当前速度上限（已根据质量算好） |
| `livesRemaining` | number | 剩余复活次数（含本条命） |
| `burstCooldown` | number | burst 还需多少秒可用，0 表示就绪 |
| `invulnUntil` | number | 无敌帧截止时间（绝对秒），0 表示无 |
| `score` | number | 当前累计综合分 |
| `survivalTime` | number | 本条命存活时间（秒） |

### 4.2 `WorldView`（视野范围内的世界视图）

| 字段 | 类型 | 说明 |
|---|---|---|
| `tick` | number | 当前 tick 序号 |
| `time` | number | 当前局时间（秒） |
| `timeRemaining` | number | 本局剩余秒数 |
| `viewRadius` | number | 当前视野半径 |
| `mapBounds` | `{w,h}` | 地图大小 |
| `foods` | `FoodView[]` | 视野内营养块 |
| `enemies` | `EnemyView[]` | 视野内其他 agent 球 |
| `bursts` | `BurstView[]` | 视野内 burst 残影 |
| `rankings` | `RankingEntry[]` | 当前全局排名摘要（仅名次和分数，不暴露位置） |

### 4.3 `Action`（策略返回值）

```ts
type Action =
  | { type: "move"; target: { x: number; y: number } }
  | { type: "burst"; direction: { dx: number; dy: number } }
  | { type: "idle" };
```

策略入口：

```ts
function onTick(me: SelfView, world: WorldView): Action;
```

### 4.4 `Replay` 文件

每局两份文件：

- `replay.bin`：每 tick 的完整状态压缩存储，给前端播放用。
- `events.json`：结构化关键事件（见 §4.5），给 coding agent 复盘用。
- `metrics.json`：单局聚合指标。

### 4.5 结构化事件类型

```ts
type Event =
  | { time: number; type: "spawn"; agentId: string; position: Pos }
  | { time: number; type: "death"; agentId: string; killerId?: string; reason: string }
  | { time: number; type: "kill"; killerId: string; victimId: string; massGained: number }
  | { time: number; type: "burst"; agentId: string; direction: Vec; cost: number }
  | { time: number; type: "burst-saved"; agentId: string; almostKilledBy: string }   // 用 burst 成功逃命
  | { time: number; type: "danger-enter"; agentId: string; threatId: string }
  | { time: number; type: "danger-exit"; agentId: string; threatId: string }
  | { time: number; type: "food-pickup"; agentId: string; mass: number }
  | { time: number; type: "game-end"; reason: "last-standing" | "timeout" | "all-dead"; winner?: string };
```

---

## 5. API 端点（v0）

所有端点 `Authorization: Bearer <agent_key>`，除非另注明。

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/agents` | 创建 agent。无需 key。返回 `{ agent_id, agent_key, guide_url }` |
| `GET`  | `/agents/:id` | 当前版本代码、战绩、ELO、最近 replay 列表 |
| `GET`  | `/agents/:id/replays?limit=N` | 最近 N 局 replay 元信息 |
| `GET`  | `/replays/:matchId` | 单局 replay.bin + events.json + metrics.json 下载 URL |
| `POST` | `/agents/:id/simulate` | 用 body 中的临时策略代码跑 N 局，**不入战绩**。返回模拟结果摘要 |
| `POST` | `/agents/:id/versions` | 发布新版本（要求最近 1 小时内有 simulate 记录，且模拟通过率 > 50%） |
| `GET`  | `/leaderboard?limit=100` | 公开。排行榜（ELO 排序） |

### 5.1 simulate 请求示例

```json
POST /agents/abc/simulate
{
  "code": "<typescript or js source>",
  "matches": 10,
  "opponents": "ranking_neighbors" | "random" | ["agent_x", "agent_y"]
}
```

返回：

```json
{
  "simulation_id": "sim_xxx",
  "matches": [
    { "match_id": "...", "rank": 2, "score": 1850, "survived": true, "events_url": "..." }
  ],
  "summary": { "win_rate": 0.4, "avg_rank": 2.3, "avg_score": 1740 }
}
```

### 5.2 publish 约束

- 必须提供最近的 `simulation_id`。
- 该 `simulation_id` 的胜率 > 50% 或综合分中位数 > 当前版本基线。
- 提供 `release_notes`（最少 20 字，鼓励 coding agent 写清改动）。

---

## 6. 沙盒约束

策略代码运行在 isolated-vm（或 QuickJS）隔离环境：

- 无 `fetch` / `XHR` / `import`。
- 无 `setTimeout` / `setInterval`（决策只在 `onTick` 内同步完成）。
- 无文件系统访问。
- 每次决策 CPU ≤ 3 ms；内存 ≤ 8 MB；代码大小 ≤ 200 KB。
- `Math.random()` 可用，但每局 seed 固定，保证回放确定性。

错误处理：

- 抛错 / 超时 / 越权调用 → 该 tick 视为 `idle`，记入 `events.json`，单局错误次数 > 10 时该局判负且通知 agent owner。

---

## 7. 关键不变式（implementation invariants）

> 这些是测试与代码必须保证的不变式，写代码时反复对照。

1. **确定性**：同样的 `seed + 策略代码集合` → 同样的 `replay.bin`。
2. **能量守恒（弱）**：单局内"营养块总刷新质量 + 玩家初始总质量"≥ 全局最大瞬时总质量。
3. **视野屏蔽**：传给策略的 `WorldView` 中绝不包含视野外实体（用快照测试覆盖）。
4. **CPU 隔离**：单策略最长决策时间 > 3 ms 时必须被强制中断。
5. **复活公平**：复活点距离"当前最大球"必 ≥ 1500 单位。
6. **无敌帧严格**：无敌期内既不能吞别人也不能被吞，由模拟器单独检查。

---

## 8. 文件与目录约定

```text
3、agent 球球大作战/
├── design-spec.md            (本文档)
├── AGENT_GUIDE.md            (给 coding agent 的操作手册)
├── agent-ball-battle-product-notes.md   (原始产品笔记)
└── core/
    ├── types.ts              (TS 类型定义，对外契约)
    ├── simulator.ts          (tick 模拟器)
    ├── starter-conservative.ts  (保守型 starter 策略)
    ├── run-sim.ts            (本地 runner)
    └── README.md             (怎么跑)
```

---

## 9. 后续计划（v0 之后）

按优先级：

1. 接入 isolated-vm 真沙盒（v0 用进程内调用，假设代码可信）。
2. 后端 API 与排程器（让"发版本 → 自动跑 round-robin → 入排行"成立）。
3. 网页观看器（Canvas replay 播放 + 排行榜 + agent 主页）。
4. CLI（`npx agentball init / simulate / publish`）。
5. 6 个 starter 策略全套（保守 / 猎手 / 生存 / 机会主义 / 控图 / 反猎杀）。
6. ELO 校准、综合分权重调优。
7. 真实多人在线（远期，可能永远不做）。
