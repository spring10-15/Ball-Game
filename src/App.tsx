import {
  Activity,
  BarChart3,
  Check,
  Copy,
  Eye,
  FileJson,
  LogOut,
  Mail,
  Palette,
  Pause,
  Play,
  RotateCcw,
  ShieldCheck,
  SkipBack,
  SkipForward,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { useEffect, useState } from "react";

import type { Event, MatchResult, Replay } from "../core/types";
import { ReplayCanvas } from "./ReplayCanvas";
import {
  agentIdForBall,
  createPlatformBall,
  deletePlatformBall,
  loadPlatformSnapshot,
  loadCurrentUser,
  logoutCurrentUser,
  ownedBallCount,
  patternLabel,
  requestLoginCode,
  type BallAppearance,
  type BallPattern,
  type AuthUser,
  type PlatformBall,
  type PlatformSnapshot,
  runPlatformMatch,
  savePlatformAppearance,
  verifyLoginCode,
} from "./platform";
import {
  type EvalSummary,
  displayAgentName,
  displayEndReason,
  displayEventType,
  displayMatchName,
  eventLabel,
  eventTone,
  eventsUntil,
  formatNumber,
  formatTime,
  frameAt,
  getAgentColor,
  loadEvalSummary,
  loadReplay,
  runLocalEvaluation,
  runLocalSimulation,
} from "./replay";

type ViewKey = "home" | "arena" | "profile";
type ArenaTabKey = "matches" | "leaderboard" | "replay";
type ProfileTabKey = "balls" | "create" | "appearance" | "rules" | "edits";
type PlatformTabKey = "balls" | "create" | "appearance" | "rules";

const playbackSpeeds = [1, 2, 4, 8, 16];
const appBuildLabel = "UAT-20260526-redeploy-v5";
const eventFilters: Array<Event["type"] | "all"> = ["all", "kill", "death", "burst", "danger-enter", "decision-error"];
const viewItems: Array<{ key: ViewKey; label: string; icon: React.ReactNode }> = [
  { key: "home", label: "首页", icon: <Activity size={17} /> },
  { key: "arena", label: "竞赛场", icon: <BarChart3 size={17} /> },
  { key: "profile", label: "个人中心", icon: <Users size={17} /> },
];
const arenaTabs: Array<{ key: ArenaTabKey; label: string; icon: React.ReactNode }> = [
  { key: "matches", label: "对战记录", icon: <FileJson size={16} /> },
  { key: "leaderboard", label: "排行榜", icon: <BarChart3 size={16} /> },
  { key: "replay", label: "对战回放", icon: <Eye size={16} /> },
];
const profileTabs: Array<{ key: ProfileTabKey; label: string; icon: React.ReactNode }> = [
  { key: "balls", label: "球球中心", icon: <Users size={16} /> },
  { key: "create", label: "创建球球", icon: <UserPlus size={16} /> },
  { key: "appearance", label: "编辑样式", icon: <Palette size={16} /> },
  { key: "rules", label: "规则编辑", icon: <Copy size={16} /> },
  { key: "edits", label: "编辑记录", icon: <Palette size={16} /> },
];

declare global {
  interface Window {
    render_game_to_text?: () => string;
    advanceTime?: (ms: number) => void;
  }
}

export function App() {
  const [replay, setReplay] = useState<Replay | null>(null);
  const [evalSummary, setEvalSummary] = useState<EvalSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [frameIndex, setFrameIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [eventFilter, setEventFilter] = useState<Event["type"] | "all">("all");
  const [view, setView] = useState<ViewKey>("home");
  const [operation, setOperation] = useState<string | null>(null);
  const [platform, setPlatform] = useState<PlatformSnapshot | null>(null);
  const [currentUser, setCurrentUser] = useState<AuthUser | null | undefined>(undefined);
  const [selectedPlatformBallId, setSelectedPlatformBallId] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([loadReplay(), loadEvalSummary(), loadCurrentUser()])
      .then(([loadedReplay, loadedEval, loadedUser]) => {
        setReplay(loadedReplay);
        setEvalSummary(loadedEval);
        setCurrentUser(loadedUser);
        setLoadError(null);
      })
      .catch((error) => {
        setLoadError(error instanceof Error ? error.message : String(error));
      });
  }, []);

  useEffect(() => {
    if (!currentUser) return;
    loadPlatformSnapshot()
      .then((loadedPlatform) => {
        setPlatform(loadedPlatform);
        setSelectedPlatformBallId(
          loadedPlatform.balls.find((ball) => ball.ownerId === currentUser.userId)?.ballId ?? loadedPlatform.balls[0]?.ballId ?? null,
        );
        setLoadError(null);
      })
      .catch((error) => {
        setLoadError(error instanceof Error ? error.message : String(error));
      });
  }, [currentUser]);

  useEffect(() => {
    if (!replay || !isPlaying) return;
    const interval = window.setInterval(() => {
      setFrameIndex((current) => {
        if (current >= replay.frames.length - 1) return current;
        return current + 1;
      });
    }, 100 / speed);
    return () => window.clearInterval(interval);
  }, [isPlaying, replay, speed]);

  useEffect(() => {
    if (!replay) return;
    if (frameIndex >= replay.frames.length - 1) setIsPlaying(false);
  }, [frameIndex, replay]);

  useEffect(() => {
    window.render_game_to_text = () =>
      JSON.stringify({
        当前视图: view,
        当前帧: frameIndex,
        参赛数量: replay?.results.length ?? 0,
        平台球球数量: platform?.balls.length ?? 0,
        用户数量: platform?.users.length ?? 0,
        选中球球: selectedPlatformBallId,
        选中参赛者: selectedAgentId,
      });
    window.advanceTime = (ms: number) => {
      if (!replay) return;
      const step = Math.max(1, Math.round(ms / 100));
      setFrameIndex((current) => Math.min(replay.frames.length - 1, current + step));
    };
    return () => {
      delete window.render_game_to_text;
      delete window.advanceTime;
    };
  }, [frameIndex, platform, replay, selectedAgentId, selectedPlatformBallId, view]);

  if (loadError) {
    return <StatusScreen title="加载失败" detail={loadError} />;
  }

  if (!replay) {
    return <StatusScreen title="回放加载中" detail="正在读取最近一局比赛数据" />;
  }

  if (currentUser === undefined) {
    return <StatusScreen title="用户状态加载中" detail="正在确认邮箱登录状态" />;
  }

  if (!currentUser) {
    return <LoginScreen onLogin={setCurrentUser} />;
  }

  if (!platform) {
    return <StatusScreen title="平台加载中" detail="正在读取球球、用户和对战记录" />;
  }

  const frame = frameAt(replay, frameIndex);
  const visibleEvents = eventsUntil(replay, frame).slice(-120).reverse();
  const activeEvents =
    eventFilter === "all" ? visibleEvents : visibleEvents.filter((event) => event.type === eventFilter);
  const selectedResult = replay.results.find((result) => result.agentId === selectedAgentId) ?? replay.results[0];
  const leader = replay.results[0];
  const endEvent = replay.events.find((event) => event.type === "game-end");
  const frameCount = replay.frames.length;
  const selectedPlatformBall =
    platform?.balls.find((ball) => ball.ballId === selectedPlatformBallId) ?? platform?.balls[0] ?? null;

  function nameOfAgent(agentId: string): string {
    const platformBall = platform?.balls.find((ball) => agentIdForBall(ball.ballId) === agentId);
    return platformBall?.name ?? replay!.results.find((result) => result.agentId === agentId)?.name ?? displayAgentName(agentId);
  }

  function colorOfAgent(agentId: string): string {
    const platformBall = platform?.balls.find((ball) => agentIdForBall(ball.ballId) === agentId);
    return platformBall?.appearance.color ?? getAgentColor(replay!, agentId);
  }

  function jump(delta: number) {
    setFrameIndex((current) => Math.max(0, Math.min(frameCount - 1, current + delta)));
  }

  function reset() {
    setFrameIndex(0);
    setIsPlaying(true);
  }

  async function runSimulationFromUi() {
    setOperation("sim");
    try {
      const nextReplay = await runLocalSimulation({
        seed: Math.floor(Date.now() % 100000),
        durationSeconds: 60,
      });
      setReplay(nextReplay);
      setFrameIndex(0);
      setSelectedAgentId(nextReplay.results[0]?.agentId ?? null);
      setIsPlaying(true);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperation(null);
    }
  }

  async function runEvaluationFromUi(matches = 30) {
    setOperation("eval");
    try {
      const nextSummary = await runLocalEvaluation({
        matches,
        duration: 60,
        seedStart: Math.floor(Date.now() % 100000),
      });
      setEvalSummary(nextSummary);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperation(null);
    }
  }

  async function createBallFromUi(input: {
    ownerName?: string;
    name?: string;
    motto?: string;
    appearance?: Partial<BallAppearance>;
  }): Promise<PlatformBall | null> {
    setOperation("platform");
    try {
      const nextPlatform = await createPlatformBall(input);
      setPlatform(nextPlatform);
      const nextSelected = nextPlatform.balls.find((ball) => ball.ownerId === currentUser?.userId) ?? nextPlatform.balls[0];
      setSelectedPlatformBallId(nextSelected?.ballId ?? null);
      return nextSelected ?? null;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setOperation(null);
    }
  }

  async function logoutFromUi() {
    setOperation("logout");
    try {
      await logoutCurrentUser();
      setCurrentUser(null);
      setSelectedPlatformBallId(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperation(null);
    }
  }

  async function saveAppearanceFromUi(input: {
    ballId: string;
    name?: string;
    motto?: string;
    appearance?: Partial<BallAppearance>;
  }) {
    setOperation("platform");
    try {
      const nextPlatform = await savePlatformAppearance(input);
      setPlatform(nextPlatform);
      setSelectedPlatformBallId(input.ballId);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperation(null);
    }
  }

  async function deleteBallFromUi(ballId: string): Promise<PlatformBall | null> {
    setOperation("platform");
    try {
      const nextPlatform = await deletePlatformBall(ballId);
      setPlatform(nextPlatform);
      const nextSelected = nextPlatform.balls.find((ball) => ball.ownerId === currentUser?.userId) ?? null;
      setSelectedPlatformBallId(nextSelected?.ballId ?? null);
      return nextSelected;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setOperation(null);
    }
  }

  async function runPlatformBattleFromUi(ballIds?: string[]) {
    setOperation("platform-match");
    try {
      const result = await runPlatformMatch({
        seed: Math.floor(Date.now() % 100000),
        durationSeconds: 60,
        ballIds,
      });
      setPlatform(result.snapshot);
      setReplay(result.replay);
      setFrameIndex(0);
      setSelectedAgentId(result.replay.results[0]?.agentId ?? null);
      setIsPlaying(true);
      setView("arena");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperation(null);
    }
  }

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <div className="brand-row">
            <span className="brand-mark">
              <Activity size={18} />
            </span>
            <span className="brand-name">球球智能体</span>
            <span className="build-badge">{appBuildLabel}</span>
          </div>
          <h1>球球资产控制台</h1>
        </div>
        <div className="match-summary">
          <div className="user-badge">
            <span>{currentUser.displayName}</span>
            <em>{currentUser.email}</em>
            <button onClick={logoutFromUi} type="button" disabled={operation === "logout"} title="退出登录">
              <LogOut size={15} />
            </button>
          </div>
          <SummaryStat label="球球" value={`${platform?.balls.length ?? 0} 个`} />
          <SummaryStat label="用户" value={`${platform?.users.length ?? 0} 位`} />
          <SummaryStat label="对局" value={`${platform?.matches.length ?? 0} 局`} />
          <SummaryStat label="榜首" value={platform?.leaderboard[0]?.ballName ?? (leader ? nameOfAgent(leader.agentId) : "暂无")} />
        </div>
      </section>

      <nav className="view-tabs" aria-label="页面视图">
        {viewItems.map((item) => (
          <button
            key={item.key}
            className={view === item.key ? "active" : ""}
            onClick={() => setView(item.key)}
            type="button"
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </nav>

      {view === "home" && platform && (
        <HomeView
          platform={platform}
          replay={replay}
          onOpenArena={() => setView("arena")}
        />
      )}

      {view === "arena" && platform && (
        <ArenaView
          colorOfAgent={colorOfAgent}
          frameIndex={frameIndex}
          isPlaying={isPlaying}
          nameOfAgent={nameOfAgent}
          onFrameChange={setFrameIndex}
          onJump={jump}
          onPlayChange={setIsPlaying}
          onReset={reset}
          onSelectAgent={setSelectedAgentId}
          onSelectBall={setSelectedPlatformBallId}
          onSpeedChange={setSpeed}
          platform={platform}
          currentUser={currentUser}
          replay={replay}
          selectedAgentId={selectedAgentId}
          selectedResult={selectedResult}
          speed={speed}
        />
      )}

      {view === "profile" && platform && (
        <ProfileView
          currentUser={currentUser}
          operation={operation}
          platform={platform}
          selectedBall={selectedPlatformBall}
          onCreateBall={createBallFromUi}
          onDeleteBall={deleteBallFromUi}
          onSaveAppearance={saveAppearanceFromUi}
          onSelectBall={setSelectedPlatformBallId}
        />
      )}
    </main>
  );
}

interface ReplayViewProps {
  replay: Replay;
  frameIndex: number;
  isPlaying: boolean;
  speed: number;
  selectedAgentId: string | null;
  selectedResult: MatchResult;
  nameOfAgent: (agentId: string) => string;
  colorOfAgent: (agentId: string) => string;
  onFrameChange: (index: number) => void;
  onJump: (delta: number) => void;
  onPlayChange: (isPlaying: boolean) => void;
  onReset: () => void;
  onSelectAgent: (agentId: string | null) => void;
  onSpeedChange: (speed: number) => void;
}

function HomeView({
  platform,
  replay,
  onOpenArena,
}: {
  platform: PlatformSnapshot;
  replay: Replay;
  onOpenArena: () => void;
}) {
  const stats = platformStats(platform);
  const topRows = platform.leaderboard.slice(0, 4);
  return (
    <section className="home-page">
      <div className="home-grid">
        <div className="home-stat-card">
          <span>当前项目总玩家数</span>
          <strong>{platform.users.length}</strong>
          <em>已登录或已创建球球的用户</em>
        </div>
        <div className="home-stat-card">
          <span>球球总数</span>
          <strong>{platform.balls.length}</strong>
          <em>每个用户最多 {platform.userLimits.maxBallsPerUser} 个</em>
        </div>
        <button className="home-stat-card quality" onClick={onOpenArena} type="button">
          <span>球球质量合计</span>
          <strong>{formatNumber(stats.totalQuality)}</strong>
          <em>按历史最好分数与胜场折算</em>
        </button>
      </div>

      <section className="home-stage">
        <div className="section-heading">
          <h2>项目动态图</h2>
          <span>{replay.results.length} 个参赛体</span>
        </div>
        <div className="orbit-board" aria-label="球球动态图">
          <span className="orbit-ring ring-one" />
          <span className="orbit-ring ring-two" />
          {platform.balls.slice(0, 6).map((ball, index) => (
            <span
              className={`orbit-ball orbit-${index + 1}`}
              key={ball.ballId}
              style={{ background: ball.appearance.color, borderColor: ball.appearance.accentColor }}
              title={ball.name}
            />
          ))}
          <div className="orbit-core">
            <strong>{platform.matches.length}</strong>
            <span>累计对局</span>
          </div>
        </div>
      </section>

      <section className="home-panel chart-card">
        <div className="section-heading">
          <h2>排行榜走势</h2>
          <span>前 {topRows.length} 名</span>
        </div>
        <div className="bar-chart">
          {topRows.map((row, index) => (
            <div className="bar-row" key={row.ballId}>
              <span>{index + 1}</span>
              <strong>{row.ballName}</strong>
              <em style={{ width: `${Math.max(8, Math.min(100, row.score / Math.max(1, topRows[0]?.score ?? 1) * 100))}%` }} />
              <b>{formatNumber(row.score)}</b>
            </div>
          ))}
        </div>
      </section>
    </section>
  );
}

function ArenaView(props: ReplayViewProps & {
  platform: PlatformSnapshot;
  currentUser: AuthUser;
  onSelectBall: (ballId: string) => void;
}) {
  const [tab, setTab] = useState<ArenaTabKey>("matches");
  return (
    <section className="platform-page">
      <div className="content-panel">
        <div className="section-heading">
          <h2>竞赛场</h2>
        </div>
        <nav className="nested-tabs" aria-label="竞赛场功能">
          {arenaTabs.map((item) => (
            <button className={tab === item.key ? "active" : ""} key={item.key} onClick={() => setTab(item.key)} type="button">
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>
      </div>
      {tab === "matches" && <MatchRecordsView platform={props.platform} ownerId={props.currentUser.userId} onSelectBall={props.onSelectBall} />}
      {tab === "leaderboard" && <LeaderboardView platform={props.platform} onSelectBall={props.onSelectBall} />}
      {tab === "replay" && <ReplayView {...props} />}
    </section>
  );
}

function ProfileView({
  currentUser,
  operation,
  platform,
  selectedBall,
  onCreateBall,
  onDeleteBall,
  onSaveAppearance,
  onSelectBall,
}: {
  currentUser: AuthUser;
  operation: string | null;
  platform: PlatformSnapshot;
  selectedBall: PlatformBall | null;
  onCreateBall: (input: {
    ownerName?: string;
    name?: string;
    motto?: string;
    appearance?: Partial<BallAppearance>;
  }) => Promise<PlatformBall | null>;
  onDeleteBall: (ballId: string) => Promise<PlatformBall | null>;
  onSaveAppearance: (input: {
    ballId: string;
    name?: string;
    motto?: string;
    appearance?: Partial<BallAppearance>;
  }) => void;
  onSelectBall: (ballId: string) => void;
}) {
  const [tab, setTab] = useState<ProfileTabKey>("balls");
  const ownedCount = ownedBallCount(platform, currentUser.userId);
  const createLimitReached = ownedCount >= platform.userLimits.maxBallsPerUser;
  function openBallSettings(ballId: string) {
    onSelectBall(ballId);
    setTab("appearance");
  }
  function selectTab(nextTab: ProfileTabKey) {
    if (nextTab === "create" && createLimitReached) return;
    setTab(nextTab);
  }
  const platformPanel = tab === "edits" ? "balls" : tab;
  return (
    <section className="platform-page">
      <div className="content-panel">
        <div className="section-heading">
          <h2>个人中心</h2>
          <span>{currentUser.email}</span>
        </div>
        <nav className="nested-tabs" aria-label="个人中心功能">
          {profileTabs.map((item) => (
            <button
              className={tab === item.key ? "active" : ""}
              disabled={item.key === "create" && createLimitReached}
              key={item.key}
              onClick={() => selectTab(item.key)}
              title={item.key === "create" && createLimitReached ? "已达到 3 个球球创建上限" : undefined}
              type="button"
            >
              {item.icon}
              {item.key === "create" && createLimitReached ? "已达上限" : item.label}
            </button>
          ))}
        </nav>
      </div>
      {tab !== "edits" && (
        <PlatformView
          currentUser={currentUser}
          operation={operation}
          panel={platformPanel}
          platform={platform}
          selectedBall={selectedBall}
          onCreateBall={onCreateBall}
          onDeleteBall={onDeleteBall}
          onPanelChange={(panel) => setTab(panel)}
          onSaveAppearance={onSaveAppearance}
          onSelectBall={openBallSettings}
        />
      )}
      {tab === "edits" && <EditRecordsView platform={platform} ownerId={currentUser.userId} onSelectBall={openBallSettings} />}
    </section>
  );
}

function ReplayView({
  replay,
  frameIndex,
  isPlaying,
  speed,
  selectedAgentId,
  selectedResult,
  nameOfAgent,
  colorOfAgent,
  onFrameChange,
  onJump,
  onPlayChange,
  onReset,
  onSelectAgent,
  onSpeedChange,
}: ReplayViewProps) {
  const frame = frameAt(replay, frameIndex);
  return (
    <>
      <section className="workspace">
        <div className="arena-panel">
          <ReplayCanvas
            replay={replay}
            frame={frame}
            selectedAgentId={selectedAgentId}
            labelForAgent={nameOfAgent}
            colorForAgent={colorOfAgent}
            onSelectAgent={onSelectAgent}
          />
          <PlaybackBar
            replay={replay}
            frameIndex={frameIndex}
            isPlaying={isPlaying}
            speed={speed}
            onFrameChange={onFrameChange}
            onJump={onJump}
            onPlayChange={onPlayChange}
            onReset={onReset}
            onSpeedChange={onSpeedChange}
          />
        </div>

        <aside className="side-panel">
          <Leaderboard replay={replay} selectedAgentId={selectedAgentId} nameOfAgent={nameOfAgent} colorOfAgent={colorOfAgent} onSelectAgent={onSelectAgent} />
          <section className="panel-section">
            <div className="section-heading">
              <h2>选中指标</h2>
              <span>{nameOfAgent(selectedResult.agentId)}</span>
            </div>
            <MetricGrid result={selectedResult} />
          </section>
        </aside>
      </section>

    </>
  );
}

function PlatformView({
  platform,
  currentUser,
  selectedBall,
  operation,
  panel,
  onCreateBall,
  onDeleteBall,
  onPanelChange,
  onSaveAppearance,
  onSelectBall,
}: {
  platform: PlatformSnapshot;
  currentUser: AuthUser;
  selectedBall: PlatformBall | null;
  operation: string | null;
  panel: PlatformTabKey;
  onCreateBall: (input: {
    ownerName?: string;
    name?: string;
    motto?: string;
    appearance?: Partial<BallAppearance>;
  }) => Promise<PlatformBall | null>;
  onDeleteBall: (ballId: string) => Promise<PlatformBall | null>;
  onPanelChange: (panel: PlatformTabKey) => void;
  onSaveAppearance: (input: {
    ballId: string;
    name?: string;
    motto?: string;
    appearance?: Partial<BallAppearance>;
  }) => void;
  onSelectBall: (ballId: string) => void;
}) {
  const ownerId = currentUser.userId;
  const [ownerName, setOwnerNameState] = useState(currentUser.displayName);
  const [newBallName, setNewBallName] = useState("我的球球");
  const [newColor, setNewColor] = useState("#2563eb");
  const [editName, setEditName] = useState(selectedBall?.name ?? "");
  const [editColor, setEditColor] = useState(selectedBall?.appearance.color ?? "#2563eb");
  const [editAccent, setEditAccent] = useState(selectedBall?.appearance.accentColor ?? "#f8fafc");
  const [editPattern, setEditPattern] = useState<BallPattern>(selectedBall?.appearance.pattern ?? "ring");
  const [copied, setCopied] = useState(false);
  const [createMessage, setCreateMessage] = useState<string | null>(null);
  const [activeBallId, setActiveBallId] = useState(selectedBall?.ballId ?? null);

  const busy = operation === "platform" || operation === "platform-match";
  const myBalls = platform.balls.filter((ball) => ball.ownerId === ownerId);
  const editableBall = myBalls.find((ball) => ball.ballId === activeBallId) ?? myBalls[0] ?? null;
  const ownerBallCount = ownedBallCount(platform, ownerId);
  const createLimitReached = ownerBallCount >= platform.userLimits.maxBallsPerUser;
  const agentEditRule = "请分析最近对战记录，让它更稳健，减少被大球吞掉的次数。";

  useEffect(() => {
    if (selectedBall?.ownerId === ownerId) setActiveBallId(selectedBall.ballId);
  }, [ownerId, selectedBall]);

  useEffect(() => {
    if (!editableBall) return;
    setEditName(editableBall.name);
    setEditColor(editableBall.appearance.color);
    setEditAccent(editableBall.appearance.accentColor);
    setEditPattern(editableBall.appearance.pattern);
  }, [editableBall]);

  const aiPacket = editableBall
    ? [
        "你是这个球球的策略调整智能体。请根据下面的信息调整球球内部策略，并把调整结果上传到指定端口。",
        "",
        `球球专属编号：${editableBall.ballId}`,
        `球球名称：${editableBall.name}`,
        `当前内部版本：第 ${editableBall.internalRevision} 版`,
        `当前托管档位：${editableBall.agentProfileLabel}`,
        `球球编辑规则：${agentEditRule}`,
        "",
        "上传端口：POST /api/agent/ball-edit-upload",
        "请求格式：JSON",
        "必须字段：actor、ballId、editRule",
        "可选字段：profile",
        "profile 可选值：balanced（均衡）、conservative（稳健）、greedy（进攻）",
        "",
        "请求示例：",
        JSON.stringify(
          {
            actor: "agent",
            ballId: editableBall.ballId,
            editRule: agentEditRule,
            profile: "conservative",
          },
          null,
          2,
        ),
        "",
        "执行要求：先理解最近对战记录和编辑规则，再选择合适托管档位；上传成功后，系统会写入球球编辑记录并提升内部版本。",
      ].join("\n")
    : "";

  async function copyAiPacket() {
    if (!aiPacket) return;
    try {
      await navigator.clipboard.writeText(aiPacket);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = aiPacket;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  function updateOwnerName(value: string) {
    setOwnerNameState(value);
  }

  async function createBall() {
    const created = await onCreateBall({
      ownerName,
      name: newBallName,
      appearance: { color: newColor },
    });
    if (!created) return;
    setActiveBallId(created.ballId);
    onSelectBall(created.ballId);
    setCreateMessage(`已创建 ${created.name}，已跳转到设置页面。`);
    onPanelChange("appearance");
  }

  function viewBall(ballId: string) {
    setActiveBallId(ballId);
    onSelectBall(ballId);
    onPanelChange("appearance");
  }

  function chooseEditableBall(ballId: string) {
    setActiveBallId(ballId);
    onSelectBall(ballId);
  }

  async function deleteEditableBall() {
    if (!editableBall) return;
    const confirmed = window.confirm(`确定删除「${editableBall.name}」吗？删除后这个球球会从列表、排行榜和记录里移除。`);
    if (!confirmed) return;
    const nextBall = await onDeleteBall(editableBall.ballId);
    setActiveBallId(nextBall?.ballId ?? null);
    if (!nextBall) onPanelChange("balls");
  }

  function BallSelector() {
    return (
      <div className="ball-selector-list" aria-label="选择球球">
        {myBalls.map((ball) => (
          <button
            className={editableBall?.ballId === ball.ballId ? "active" : ""}
            key={ball.ballId}
            onClick={() => chooseEditableBall(ball.ballId)}
            type="button"
          >
            <span className="ball-avatar small" style={{ background: ball.appearance.color }} />
            <span>
              <strong>{ball.name}</strong>
              <em>{ball.ballId}</em>
            </span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <section className="platform-page">
      {createMessage && <div className="success-note platform-alert">{createMessage}</div>}

      {panel === "balls" && (
        <div className="content-panel my-balls-panel">
          <div className="section-heading">
            <h2>我的球球</h2>
            <span>创建与查看</span>
          </div>
          <div className="ball-grid">
            {myBalls.map((ball) => (
              <BallCard
                ball={ball}
                key={ball.ballId}
                selected={editableBall?.ballId === ball.ballId}
                onSelectBall={viewBall}
              />
            ))}
          </div>
          {myBalls.length === 0 && <EmptyPanel text="你还没有创建球球，先去创建一个。" />}
        </div>
      )}

      {panel === "create" && (
        <section className="wide-grid">
          <div className="content-panel span-5">
            <div className="section-heading">
              <h2>创建球球</h2>
              <span>{ownerBallCount}/{platform.userLimits.maxBallsPerUser}</span>
            </div>
            <div className="form-stack">
              <label>
                <span>用户名</span>
                <input value={ownerName} onChange={(event) => updateOwnerName(event.target.value)} />
              </label>
              <label>
                <span>球球名称</span>
                <input value={newBallName} onChange={(event) => setNewBallName(event.target.value)} />
              </label>
              <label>
                <span>主色</span>
                <input type="color" value={newColor} onChange={(event) => setNewColor(event.target.value)} />
              </label>
              <button
                disabled={busy || createLimitReached}
                onClick={createBall}
                type="button"
              >
                <UserPlus size={16} />
                {createLimitReached ? "已达创建上限" : "创建球球"}
              </button>
              {createMessage && <div className="success-note">{createMessage}</div>}
            </div>
          </div>
          <div className="content-panel span-7">
            <div className="section-heading">
              <h2>用户边界</h2>
              <span>最多 {platform.userLimits.maxBallsPerUser} 个</span>
            </div>
            <div className="rule-grid two-column">
              <RulePill icon={<Palette size={16} />} label="用户可改" values={platform.agentRules.userCanEdit} />
              <RulePill icon={<ShieldCheck size={16} />} label="智能体专管" values={platform.agentRules.agentOnly} />
            </div>
          </div>
        </section>
      )}

      {panel === "appearance" && (
        <div className="content-panel">
          <div className="section-heading">
            <h2>编辑样式</h2>
            <span>{editableBall ? editableBall.name : "未选中"}</span>
          </div>
          {editableBall ? (
            <div className="ball-editor-layout">
              <BallSelector />
              <div className="appearance-editor">
                <BallPreview ball={editableBall} color={editColor} accentColor={editAccent} pattern={editPattern} />
                <div className="form-stack">
                  <label>
                    <span>球球名称</span>
                    <input value={editName} onChange={(event) => setEditName(event.target.value)} />
                  </label>
                  <div className="color-row">
                    <label>
                      <span>主色</span>
                      <input type="color" value={editColor} onChange={(event) => setEditColor(event.target.value)} />
                    </label>
                    <label>
                      <span>描边</span>
                      <input type="color" value={editAccent} onChange={(event) => setEditAccent(event.target.value)} />
                    </label>
                  </div>
                  <div className="pattern-group" aria-label="花纹">
                    {(["ring", "spark", "solid"] as BallPattern[]).map((pattern) => (
                      <button
                        className={editPattern === pattern ? "active" : ""}
                        key={pattern}
                        onClick={() => setEditPattern(pattern)}
                        type="button"
                      >
                        {patternLabel(pattern)}
                      </button>
                    ))}
                  </div>
                  <button
                    disabled={busy}
                    onClick={() => onSaveAppearance({
                      ballId: editableBall.ballId,
                      name: editName,
                      appearance: { color: editColor, accentColor: editAccent, pattern: editPattern },
                    })}
                    type="button"
                  >
                    保存外观
                  </button>
                  <button
                    className="danger-action"
                    disabled={busy}
                    onClick={deleteEditableBall}
                    type="button"
                  >
                    <Trash2 size={16} />
                    删除球球
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <EmptyPanel text="先选择一个球球，再修改外观。" />
          )}
        </div>
      )}

      {panel === "rules" && (
        <div className="content-panel">
          <div className="section-heading">
            <h2>规则编辑</h2>
            <span>{platform.sharePort.label}</span>
          </div>
          {editableBall ? (
            <div className="rule-copy-layout">
              <BallSelector />
              <div className="agent-copy-card">
                <span className="ball-avatar" style={{ background: editableBall.appearance.color, borderColor: editableBall.appearance.accentColor }} />
                <div>
                  <h3>{editableBall.name}</h3>
                  <p>已准备好这个球球的专属编号和编辑上传指引。</p>
                </div>
                <button className="copy-action" onClick={copyAiPacket} type="button">
                  {copied ? <Check size={15} /> : <Copy size={15} />}
                  {copied ? "已复制" : "复制给智能体"}
                </button>
              </div>
            </div>
          ) : (
            <EmptyPanel text="先选择一个球球，再查看智能体编辑端口。" />
          )}
        </div>
      )}
    </section>
  );
}

function LoginScreen({ onLogin }: { onLogin: (user: AuthUser) => void }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [phase, setPhase] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function requestCode() {
    setBusy(true);
    setError(null);
    try {
      const result = await requestLoginCode(email);
      setDevCode(result.devCode ?? null);
      setPhase("code");
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : String(authError));
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode() {
    setBusy(true);
    setError(null);
    try {
      onLogin(await verifyLoginCode(email, code));
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : String(authError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="brand-row">
          <span className="brand-mark">
            <Activity size={18} />
          </span>
          <span className="brand-name">球球智能体</span>
        </div>
        <h1>邮箱登录</h1>
        <div className="form-stack">
          <label>
            <span>邮箱</span>
            <input
              autoComplete="email"
              disabled={busy || phase === "code"}
              inputMode="email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              value={email}
            />
          </label>
          {phase === "code" && (
            <label>
              <span>验证码</span>
              <input
                autoComplete="one-time-code"
                inputMode="numeric"
                maxLength={6}
                onChange={(event) => setCode(event.target.value)}
                placeholder="6 位数字"
                value={code}
              />
            </label>
          )}
          {devCode && <div className="dev-code">本地开发验证码：{devCode}</div>}
          {error && <div className="form-error">{error}</div>}
          {phase === "email" ? (
            <button disabled={busy} onClick={requestCode} type="button">
              <Mail size={16} />
              获取验证码
            </button>
          ) : (
            <button disabled={busy} onClick={verifyCode} type="button">
              <Check size={16} />
              登录
            </button>
          )}
        </div>
      </section>
    </main>
  );
}

function BallCard({
  ball,
  selected,
  onSelectBall,
}: {
  ball: PlatformBall;
  selected: boolean;
  onSelectBall: (ballId: string) => void;
}) {
  return (
    <article className={`ball-card ${selected ? "selected" : ""}`}>
      <button className="ball-card-main" onClick={() => onSelectBall(ball.ballId)} type="button">
        <span className="ball-avatar" style={{ background: ball.appearance.color, borderColor: ball.appearance.accentColor }} />
        <span>
          <strong>{ball.name}</strong>
          <em>{ball.ownerName}</em>
        </span>
        <b>查看</b>
      </button>
      <div className="ball-card-copy">{ball.motto}</div>
      <div className="id-strip">专属编号：{ball.ballId}</div>
      <div className="readonly-grid">
        <MetricMini label="托管" value={ball.agentProfileLabel} />
        <MetricMini label="版本" value={`第 ${ball.internalRevision} 版`} />
        <MetricMini label="对局" value={`${ball.record.matches} 局`} />
        <MetricMini label="胜场" value={`${ball.record.wins} 场`} />
        <MetricMini label="均名" value={ball.record.matches ? formatNumber(ball.record.avgRank, 2) : "暂无"} />
        <MetricMini label="击杀" value={`${ball.record.totalKills}`} />
      </div>
    </article>
  );
}

function BallPreview({
  ball,
  color,
  accentColor,
  pattern,
}: {
  ball: PlatformBall;
  color: string;
  accentColor: string;
  pattern: BallPattern;
}) {
  return (
    <div className={`ball-preview pattern-${pattern}`} style={{ background: color, borderColor: accentColor }}>
      <span>{ball.name.slice(0, 4)}</span>
    </div>
  );
}

function RulePill({ icon, label, values }: { icon: React.ReactNode; label: string; values: string[] }) {
  return (
    <div className="rule-pill">
      <strong>{icon}{label}</strong>
      <span>{values.join("、")}</span>
    </div>
  );
}

function MetricMini({ label, value }: { label: string; value: string }) {
  return (
    <span className="metric-mini">
      <em>{label}</em>
      <strong>{value}</strong>
    </span>
  );
}

function platformStats(platform: PlatformSnapshot): { totalQuality: number } {
  const totalQuality = platform.balls.reduce((sum, ball) => {
    const record = ball.record;
    const base = record.bestScore || record.lastScore || 100;
    return sum + base + record.wins * 250 + record.totalKills * 25;
  }, 0);
  return { totalQuality: Math.round(totalQuality) };
}

function speedRecommendation(replay: Replay): number {
  const duration = replay.config.durationSeconds;
  if (duration <= 90) return 1;
  if (duration <= 180) return 2;
  return 4;
}

function winnerName(platform: PlatformSnapshot, ballId: string | undefined): string {
  return platform.balls.find((ball) => ball.ballId === ballId)?.name ?? "暂无胜者";
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return `${date.getMonth() + 1}月${date.getDate()}日 ${date.getHours().toString().padStart(2, "0")}:${date
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
}

function MatchRecordsView({
  platform,
  ownerId,
  onSelectBall,
}: {
  platform: PlatformSnapshot;
  ownerId: string;
  onSelectBall: (ballId: string) => void;
}) {
  const myBalls = platform.balls.filter((ball) => ball.ownerId === ownerId);
  const myBallIds = new Set(myBalls.map((ball) => ball.ballId));
  const rows = platform.matches.flatMap((match) =>
    match.results
      .filter((result) => myBallIds.has(result.ballId))
      .map((result) => ({ match, result })),
  );
  return (
    <section className="wide-grid">
      <div className="content-panel span-12">
        <div className="section-heading">
          <h2>我的参赛记录</h2>
          <span>{rows.length} 条</span>
        </div>
        {rows.length > 0 ? (
          <div className="match-list">
            {rows.map(({ match, result }) => (
              <div className="match-row" key={`${match.matchId}-${result.ballId}`}>
                <span>{formatDate(match.createdAt)}</span>
                <strong>{result.ballName}</strong>
                <span>第 {result.rank} 名</span>
                <b>分数 {formatNumber(result.score)} ｜ 胜者 {winnerName(platform, match.winnerBallId)}</b>
              </div>
            ))}
          </div>
        ) : (
          <EmptyPanel text="你的球球还没有参加过对战。" />
        )}
      </div>
    </section>
  );
}

function EditRecordsView({
  platform,
  ownerId,
  onSelectBall,
}: {
  platform: PlatformSnapshot;
  ownerId?: string;
  onSelectBall: (ballId: string) => void;
}) {
  const records = ownerId ? platform.editRecords.filter((record) => record.ownerId === ownerId) : platform.editRecords;
  return (
    <section className="wide-grid">
      <div className="content-panel span-12">
        <div className="section-heading">
          <h2>球球编辑记录</h2>
          <span>{records.length} 条</span>
        </div>
        {records.length > 0 ? (
          <div className="edit-log-list">
            {records.map((record) => (
              <button className="edit-log-row" key={record.editId} onClick={() => onSelectBall(record.ballId)} type="button">
                <span>{formatDate(record.createdAt)}</span>
                <strong>{record.ballName}</strong>
                <em>{record.actor === "agent" ? "智能体上传" : "用户网页"}</em>
                <b>{record.summary}</b>
                <small>{record.ruleText ?? "基础资料变更"}</small>
              </button>
            ))}
          </div>
        ) : (
          <EmptyPanel text="还没有编辑记录。" />
        )}
      </div>
    </section>
  );
}

function LeaderboardView({
  platform,
  onSelectBall,
}: {
  platform: PlatformSnapshot;
  onSelectBall: (ballId: string) => void;
}) {
  return (
    <section className="wide-grid">
      <div className="content-panel span-12">
        <div className="section-heading">
          <h2>球球排行榜</h2>
          <span>{platform.leaderboard.length} 个球球</span>
        </div>
        <div className="ranking-table">
          <div className="ranking-row ranking-head">
            <span>名次</span>
            <span>球球</span>
            <span>用户</span>
            <span>积分</span>
            <span>对局</span>
            <span>胜场</span>
            <span>均名</span>
          </div>
          {platform.leaderboard.map((row, index) => (
            <button className="ranking-row" key={row.ballId} onClick={() => onSelectBall(row.ballId)} type="button">
              <span>{index + 1}</span>
              <strong>{row.ballName}</strong>
              <span>{row.ownerName}</span>
              <b>{formatNumber(row.score)}</b>
              <span>{row.matches}</span>
              <span>{row.wins}</span>
              <span>{row.matches ? formatNumber(row.avgRank, 2) : "暂无"}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function TrainingView({
  evalSummary,
  operation,
  replay,
  onRunEvaluation,
  onRunSimulation,
}: {
  evalSummary: EvalSummary | null;
  operation: string | null;
  replay: Replay;
  onRunEvaluation: () => void;
  onRunSimulation: () => void;
}) {
  const best = evalSummary?.summary[0];
  return (
    <section className="wide-grid">
      <div className="content-panel span-12">
        <ActionBar
          operation={operation}
          onRunEvaluation={onRunEvaluation}
          onRunSimulation={onRunSimulation}
        />
      </div>
      <div className="content-panel span-8">
        <div className="section-heading">
          <h2>训练评测</h2>
          <span>{evalSummary ? `${evalSummary.args.matches} 局` : "暂无评测"}</span>
        </div>
        {evalSummary ? (
          <div className="eval-table">
            <div className="eval-row eval-head">
              <span>智能体</span>
              <span>胜率</span>
              <span>名次</span>
              <span>分数</span>
              <span>质量</span>
              <span>出局</span>
              <span>冲刺</span>
            </div>
            {evalSummary.summary.map((row) => (
              <div className="eval-row" key={row.agentId}>
                <strong>{displayAgentName(row.agentId)}</strong>
                <span>{formatNumber(row.winRate * 100)}%</span>
                <span>{formatNumber(row.avgRank, 2)}</span>
                <span>{formatNumber(row.avgScore)}</span>
                <span>{formatNumber(row.avgFinalMass)}</span>
                <span>{formatNumber(row.avgDeaths, 2)}</span>
                <span>{formatNumber(row.burstEfficiency * 100)}%</span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyPanel text="点击“开始百局评测”后，这里会显示多局训练结果。" />
        )}
      </div>

      <div className="content-panel span-4">
        <div className="section-heading">
          <h2>候选结论</h2>
          <span>{best ? displayAgentName(best.agentId) : "等待评测"}</span>
        </div>
        <div className="callout">
          <strong>{best ? `${displayAgentName(best.agentId)} 当前最好` : "等待评测数据"}</strong>
          <p>
            {best
              ? `平均名次 ${formatNumber(best.avgRank, 2)}，胜率 ${formatNumber(best.winRate * 100)}%，平均分 ${formatNumber(best.avgScore)}。`
              : "点击右上角的一键评测，生成多局结果后再判断策略强弱。"}
          </p>
        </div>
      </div>

      <div className="content-panel span-12">
        <div className="section-heading">
          <h2>最近单局结果</h2>
          <span>{displayMatchName(replay.matchId, replay.seed)}</span>
        </div>
        <div className="result-cards">
          {replay.results.map((result) => (
            <div className="result-card" key={result.agentId}>
              <span className="agent-dot" style={{ background: getAgentColor(replay, result.agentId) }} />
              <strong>{displayAgentName(result.agentId)}</strong>
              <span>第 {result.rank} 名</span>
              <b>{formatNumber(result.score)}</b>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ActionBar({
  operation,
  onRunEvaluation,
  onRunSimulation,
}: {
  operation: string | null;
  onRunEvaluation: () => void;
  onRunSimulation: () => void;
}) {
  return (
    <div className="action-bar">
      <div>
        <h2>本地训练操作</h2>
        <p>直接运行本地模拟引擎，生成新战报和多局评测。</p>
      </div>
      <div className="action-buttons">
        <button disabled={!!operation} onClick={onRunSimulation} type="button">
          {operation === "sim" ? "正在模拟" : "开始单局模拟"}
        </button>
        <button disabled={!!operation} onClick={onRunEvaluation} type="button">
          {operation === "eval" ? "正在评测" : "开始百局评测"}
        </button>
      </div>
    </div>
  );
}

function EventsView({ replay, nameOfAgent }: { replay: Replay; nameOfAgent: (agentId: string) => string }) {
  const counts = replay.events.reduce<Record<string, number>>((acc, event) => {
    acc[event.type] = (acc[event.type] ?? 0) + 1;
    return acc;
  }, {});
  const highSignal = replay.events.filter((event) =>
    ["death", "kill", "burst", "burst-saved", "danger-enter", "decision-error", "game-end"].includes(event.type),
  );
  return (
    <section className="wide-grid">
      <div className="content-panel span-4">
        <div className="section-heading">
          <h2>事件统计</h2>
          <span>{replay.events.length} 条事件</span>
        </div>
        <div className="metric-grid">
          {Object.entries(counts).map(([type, count]) => (
            <div className="metric-tile" key={type}>
              <span>{displayEventType(type as Event["type"])}</span>
              <strong>{count}</strong>
            </div>
          ))}
        </div>
      </div>
      <div className="content-panel span-8">
        <div className="section-heading">
          <h2>高信号复盘</h2>
          <span>{highSignal.length} 条关键事件</span>
        </div>
        <div className="events-list full">
          {highSignal.map((event, index) => (
            <div className={`event-row ${eventTone(event.type)}`} key={`${event.tick}-${event.type}-${index}`}>
              <span className="event-time">{formatTime(event.time)}</span>
              <span className="event-type">{displayEventType(event.type)}</span>
              <span className="event-copy">{eventLabel(event, nameOfAgent)}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function GuideView() {
  return (
    <section className="wide-grid">
      <div className="content-panel span-7">
        <div className="section-heading">
          <h2>开发闭环</h2>
          <span>本地版本</span>
        </div>
        <ol className="guide-steps">
          <li>先看最近战报，定位智能体在哪些时刻冒险或被吞噬。</li>
          <li>再看训练评测，用多局平均名次判断策略是否真的变强。</li>
          <li>每次只改一个策略点，例如逃跑距离、冲刺时机或追击阈值。</li>
          <li>点击单局模拟生成新战报，再点击百局评测确认趋势。</li>
        </ol>
      </div>
      <div className="content-panel span-5">
        <div className="section-heading">
          <h2>当前边界</h2>
          <span>初版</span>
        </div>
        <div className="constraint-list">
          <span>动作只有移动、冲刺、停留三类。</span>
          <span>物理每秒推进三十次，策略每秒决策十次。</span>
          <span>回放来自本地模拟结果，不是线上排行榜。</span>
          <span>当前还没有生产级策略沙盒。</span>
        </div>
      </div>
    </section>
  );
}

function PlaybackBar({
  replay,
  frameIndex,
  isPlaying,
  speed,
  onFrameChange,
  onJump,
  onPlayChange,
  onReset,
  onSpeedChange,
}: {
  replay: Replay;
  frameIndex: number;
  isPlaying: boolean;
  speed: number;
  onFrameChange: (index: number) => void;
  onJump: (delta: number) => void;
  onPlayChange: (isPlaying: boolean) => void;
  onReset: () => void;
  onSpeedChange: (speed: number) => void;
}) {
  const frame = frameAt(replay, frameIndex);
  const progress = frameIndex / Math.max(1, replay.frames.length - 1);
  return (
    <div className="playback-bar">
      <div className="playback-buttons">
        <IconButton label="回到开头" onClick={onReset}>
          <RotateCcw size={18} />
        </IconButton>
        <IconButton label="后退" onClick={() => onJump(-10)}>
          <SkipBack size={18} />
        </IconButton>
        <IconButton label={isPlaying ? "暂停" : "播放"} onClick={() => onPlayChange(!isPlaying)} primary>
          {isPlaying ? <Pause size={18} /> : <Play size={18} />}
        </IconButton>
        <IconButton label="前进" onClick={() => onJump(10)}>
          <SkipForward size={18} />
        </IconButton>
      </div>

      <div className="timeline">
        <div className="time-labels">
          <span>{formatTime(frame.time)}</span>
          <span>{Math.round(progress * 100)}%</span>
        </div>
        <input
          aria-label="回放进度"
          max={replay.frames.length - 1}
          min={0}
          onChange={(event) => onFrameChange(Number(event.target.value))}
          type="range"
          value={frameIndex}
        />
      </div>

      <div className="speed-group" aria-label="播放速度">
        {playbackSpeeds.map((option) => (
          <button
            key={option}
            className={option === speed ? "active" : ""}
            onClick={() => onSpeedChange(option)}
            type="button"
          >
            {option}倍
          </button>
        ))}
      </div>
    </div>
  );
}

function Leaderboard({
  replay,
  selectedAgentId,
  nameOfAgent,
  colorOfAgent,
  onSelectAgent,
}: {
  replay: Replay;
  selectedAgentId: string | null;
  nameOfAgent: (agentId: string) => string;
  colorOfAgent: (agentId: string) => string;
  onSelectAgent: (agentId: string) => void;
}) {
  return (
    <section className="panel-section">
      <div className="section-heading">
        <h2>结果榜</h2>
        <span>{replay.results.length} 个智能体</span>
      </div>
      <div className="leaderboard">
        {replay.results.map((result) => (
          <button
            key={result.agentId}
            className={`leader-row ${selectedAgentId === result.agentId ? "selected" : ""}`}
            onClick={() => onSelectAgent(result.agentId)}
            type="button"
          >
            <span className="rank">{result.rank}</span>
            <span className="agent-dot" style={{ background: colorOfAgent(result.agentId) }} />
            <span className="agent-name">{nameOfAgent(result.agentId)}</span>
            <span className="score">{formatNumber(result.score)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function EventStrip({
  activeEvents,
  eventFilter,
  frameTime,
  nameOfAgent,
  onEventFilterChange,
}: {
  activeEvents: Event[];
  eventFilter: Event["type"] | "all";
  frameTime: number;
  nameOfAgent: (agentId: string) => string;
  onEventFilterChange: (filter: Event["type"] | "all") => void;
}) {
  return (
    <section className="event-panel">
      <div className="event-toolbar">
        <div>
          <h2>事件流</h2>
          <p>{formatTime(frameTime)} 前已发生的关键事件</p>
        </div>
        <div className="filter-group">
          {eventFilters.map((filter) => (
            <button
              key={filter}
              className={eventFilter === filter ? "active" : ""}
              onClick={() => onEventFilterChange(filter)}
              type="button"
            >
              {displayEventType(filter)}
            </button>
          ))}
        </div>
      </div>
      <div className="events-list">
        {activeEvents.map((event, index) => (
          <div className={`event-row ${eventTone(event.type)}`} key={`${event.tick}-${event.type}-${index}`}>
            <span className="event-time">{formatTime(event.time)}</span>
            <span className="event-type">{displayEventType(event.type)}</span>
            <span className="event-copy">{eventLabel(event, nameOfAgent)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function MetricGrid({ result }: { result: MatchResult }) {
  const metrics = result.metrics;
  const items = [
    ["最终质量", formatNumber(metrics.finalMass)],
    ["吞噬数", formatNumber(metrics.kills)],
    ["出局数", formatNumber(metrics.deaths)],
    ["进食量", formatNumber(metrics.foodPickedMass)],
    ["存活", `${formatNumber(metrics.survivalTime, 1)} 秒`],
  ];
  return (
    <div className="metric-grid">
      {items.map(([label, value]) => (
        <div className="metric-tile" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="summary-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function IconButton({
  children,
  label,
  onClick,
  primary = false,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      aria-label={label}
      className={`icon-button ${primary ? "primary" : ""}`}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

function EmptyPanel({ text }: { text: string }) {
  return <div className="empty-inline">{text}</div>;
}

function StatusScreen({ title, detail }: { title: string; detail: string }) {
  return (
    <main className="app-shell">
      <section className="empty-state">
        <h1>{title}</h1>
        <p>{detail}</p>
      </section>
    </main>
  );
}
