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
  UserPlus,
  Users,
} from "lucide-react";
import { useEffect, useState } from "react";

import type { Event, MatchResult, Replay } from "../core/types";
import privacyComicUrl from "./assets/privacy-comic-v1.png";
import privacyPolicySource from "./assets/privacy-policy.md?raw";
import { ReplayCanvas } from "./ReplayCanvas";
import {
  agentIdForBall,
  createPlatformBall,
  joinPlatformEvent,
  loadPlatformSnapshot,
  loadPlatformReplay,
  loadCurrentUser,
  logoutCurrentUser,
  ownedBallCount,
  patternLabel,
  requestLoginCode,
  type BallAppearance,
  type BallPattern,
  type AuthUser,
  type PlatformBall,
  type PlatformMatchRecord,
  type PlatformSnapshot,
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
type ProfileTabKey = "balls" | "create" | "appearance" | "agent" | "edits";
type PlatformTabKey = "balls" | "create" | "appearance" | "agent";

const playbackSpeeds = [1, 2, 4, 8, 16];
const appBuildLabel = "v20260529";
const privacyPolicyDownloadUrl = `data:text/markdown;charset=utf-8,${encodeURIComponent(privacyPolicySource)}`;
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
  { key: "appearance", label: "编辑外观", icon: <Palette size={16} /> },
  { key: "agent", label: "复制给 Agent", icon: <Copy size={16} /> },
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
  const [profileEntryTab, setProfileEntryTab] = useState<ProfileTabKey>("balls");
  const [arenaEntryTab, setArenaEntryTab] = useState<ArenaTabKey>("matches");

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
        loadLatestPlatformReplay(loadedPlatform);
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
    return <StatusScreen title="正在进入平台" detail="正在准备登录与比赛数据" />;
  }

  if (currentUser === undefined) {
    return <StatusScreen title="正在进入平台" detail="正在确认邮箱登录状态" />;
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

  async function joinEventFromUi() {
    setOperation("event");
    try {
      const result = await joinPlatformEvent();
      setPlatform(result.snapshot);
      if (result.replay) {
        setReplay(result.replay);
        setFrameIndex(0);
        setSelectedAgentId(result.replay.results[0]?.agentId ?? null);
        setIsPlaying(true);
        setArenaEntryTab("replay");
      } else {
        setArenaEntryTab("matches");
      }
      setView("arena");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperation(null);
    }
  }

  async function openMatchReplayFromUi(matchId: string) {
    setOperation("replay");
    try {
      const nextReplay = await loadPlatformReplay(matchId);
      setReplay(nextReplay);
      setFrameIndex(0);
      setSelectedAgentId(nextReplay.results[0]?.agentId ?? null);
      setIsPlaying(true);
      setArenaEntryTab("replay");
      setView("arena");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperation(null);
    }
  }

  async function loadLatestPlatformReplay(nextPlatform: PlatformSnapshot) {
    for (const match of nextPlatform.matches) {
      if (!canOpenMatchReplay(match)) continue;
      try {
        const nextReplay = await loadPlatformReplay(match.matchId);
        setReplay(nextReplay);
        setFrameIndex(0);
        setSelectedAgentId(nextReplay.results[0]?.agentId ?? null);
        setIsPlaying(false);
        return;
      } catch {
        // 旧记录可能没有独立回放文件，继续尝试下一局。
      }
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
          <h1>球球竞技场</h1>
        </div>
        <div className="match-summary">
          <div className="user-badge">
            <div className="user-badge-text">
              <span>{currentUser.displayName}</span>
              <em>{currentUser.email}</em>
            </div>
            <button onClick={logoutFromUi} type="button" disabled={operation === "logout"} title="退出当前账号并返回登录页">
              <LogOut size={15} />
              {operation === "logout" ? "退出中" : "切换账号"}
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
          onOpenArena={() => {
            setArenaEntryTab("matches");
            setView("arena");
          }}
          onOpenCreate={() => {
            setProfileEntryTab("create");
            setView("profile");
          }}
          onOpenAgentHandoff={() => {
            setProfileEntryTab("agent");
            setView("profile");
          }}
        />
      )}

      {view === "arena" && platform && (
        <ArenaView
          entryTab={arenaEntryTab}
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
          onJoinEvent={joinEventFromUi}
          onOpenMatchReplay={openMatchReplayFromUi}
          onSpeedChange={setSpeed}
          operation={operation}
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
          entryTab={profileEntryTab}
          operation={operation}
          platform={platform}
          selectedBall={selectedPlatformBall}
          onCreateBall={createBallFromUi}
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
  onOpenCreate,
  onOpenAgentHandoff,
}: {
  platform: PlatformSnapshot;
  replay: Replay;
  onOpenArena: () => void;
  onOpenCreate: () => void;
  onOpenAgentHandoff: () => void;
}) {
  const stats = platformStats(platform);
  const topRows = platform.leaderboard.slice(0, 4);
  return (
    <section className="home-page">
      <section className="home-stage home-arena-hero">
        <div className="section-heading">
          <h2>自动竞技场</h2>
          <span>{platform.autoMatch.minPlayers} 球成局</span>
        </div>
        <div className="hero-copy">
          <strong>自动开局</strong>
          <p>最新战场已就绪，球球够数后自动开局。</p>
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
            <strong>{platform.autoMatch.minPlayers} 球</strong>
            <span>够数开战</span>
          </div>
        </div>
      </section>

      <section className="home-panel home-command-panel">
        <div className="section-heading">
          <h2>开场路径</h2>
          <span>人类入口</span>
        </div>
        <div className="home-flow">
          <button onClick={onOpenCreate} type="button">
            <b>1</b>
            <span>
              <strong><UserPlus size={18} />创建外观</strong>
              <em>名称、主色、花纹</em>
            </span>
          </button>
          <button onClick={onOpenAgentHandoff} type="button">
            <b>2</b>
            <span>
              <strong><Copy size={18} />交给 Agent</strong>
              <em>技能、战略、方向</em>
            </span>
          </button>
          <button onClick={onOpenArena} type="button">
            <b>3</b>
            <span>
              <strong><Eye size={18} />观看比赛</strong>
              <em>{platform.matches.length} 局战报</em>
            </span>
          </button>
        </div>
      </section>

      <div className="home-grid">
        <div className="home-stat-card">
          <span>当前用户</span>
          <strong>{platform.users.length}</strong>
        </div>
        <div className="home-stat-card">
          <span>球球总数</span>
          <strong>{platform.balls.length}</strong>
        </div>
        <button className="home-stat-card quality" onClick={onOpenArena} type="button">
          <span>战力热度</span>
          <strong>{formatNumber(stats.totalQuality)}</strong>
          <em>{replay.results.length} 个参赛体正在回放</em>
        </button>
      </div>

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
  entryTab: ArenaTabKey;
  operation: string | null;
  onJoinEvent: () => void;
  onOpenMatchReplay: (matchId: string) => void;
  onSelectBall: (ballId: string) => void;
}) {
  const [tab, setTab] = useState<ArenaTabKey>("matches");
  useEffect(() => {
    setTab(props.entryTab);
  }, [props.entryTab]);
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
      {tab === "matches" && (
        <>
          <EventActivityView
            currentUser={props.currentUser}
            operation={props.operation}
            platform={props.platform}
            onJoinEvent={props.onJoinEvent}
          />
          <MatchRecordsView
            operation={props.operation}
            platform={props.platform}
            onOpenMatchReplay={props.onOpenMatchReplay}
            onSelectBall={props.onSelectBall}
          />
        </>
      )}
      {tab === "leaderboard" && <LeaderboardView platform={props.platform} onSelectBall={props.onSelectBall} />}
      {tab === "replay" && <ReplayView {...props} />}
    </section>
  );
}

function ProfileView({
  currentUser,
  entryTab,
  operation,
  platform,
  selectedBall,
  onCreateBall,
  onSaveAppearance,
  onSelectBall,
}: {
  currentUser: AuthUser;
  entryTab: ProfileTabKey;
  operation: string | null;
  platform: PlatformSnapshot;
  selectedBall: PlatformBall | null;
  onCreateBall: (input: {
    ownerName?: string;
    name?: string;
    motto?: string;
    appearance?: Partial<BallAppearance>;
  }) => Promise<PlatformBall | null>;
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
  useEffect(() => {
    setTab(entryTab);
  }, [entryTab]);
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
  const agentEditRule = "由 Agent 根据最近对战记录自主定义球球的行为、技能、战略和移动方向；人类只负责外观。";
  const agentUploadUrl = `${window.location.origin}/api/agent/ball-edit-upload`;

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
        `当前专属技能：${editableBall.skillLabel}`,
        `技能说明：${editableBall.skillDescription}`,
        `权限边界：${agentEditRule}`,
        "",
        `上传端口：POST ${agentUploadUrl}`,
        "请求格式：JSON",
        "必须字段：actor、ballId、editRule",
        "可选字段：profile、skill、skillRule",
        "profile 可选值：balanced（均衡）、conservative（稳健）、greedy（进攻）",
        "skill 可以写自定义技能名称或一句技能设定，例如：猎手机会、中心控场、影子绕行、抢豆雷达、贴边求生。",
        "skillRule 可以写更完整的触发条件、风险阈值、地图偏好、追击/撤退优先级；系统会自动归类到可执行的行为模型。",
        "当前可识别的行为模型：觅食、避险、短冲、猎手、贴边、中心控场、影子绕行。你可以用中文自由组合描述。",
        "技能边界：可以大幅调整本球决策逻辑；不能修改全局质量收益、吞噬判定、复活、无敌、冷却，也不能直接修改其他球球状态。",
        "",
        "请求示例：",
        JSON.stringify(
          {
            actor: "agent",
            ballId: editableBall.ballId,
            editRule: agentEditRule,
            profile: "conservative",
            skill: "影子猎手",
            skillRule: "前半局贴近中心资源区发育；发现质量低于自己 70% 的球时主动追击；遇到大球时绕到安全半径外侧游走，不硬碰。",
          },
          null,
          2,
        ),
        "",
        "fetch 上传示例：",
        `await fetch("${agentUploadUrl}", {`,
        "  method: \"POST\",",
        "  headers: { \"Content-Type\": \"application/json\" },",
        "  body: JSON.stringify(上面的请求示例)",
        "});",
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

  async function createBall() {
    const created = await onCreateBall({
      ownerName: currentUser.displayName,
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
            <span>外观与战绩</span>
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
          {myBalls.length === 0 && <EmptyPanel text="先创建一个球球外观，再复制给 Agent 接管。" />}
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
                <span>出场名</span>
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
              <h2>权限边界</h2>
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
            <h2>编辑外观</h2>
            <span>{editableBall ? editableBall.name : "未选中"}</span>
          </div>
          {editableBall ? (
            <div className="ball-editor-layout">
              <BallSelector />
              <div className="appearance-editor">
                <BallPreview ball={editableBall} color={editColor} accentColor={editAccent} pattern={editPattern} />
                <div className="form-stack">
                  <label>
                    <span>出场名</span>
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
                </div>
              </div>
            </div>
          ) : (
            <EmptyPanel text="先选择一个球球，再修改外观。" />
          )}
        </div>
      )}

      {panel === "agent" && (
        <div className="content-panel">
          <div className="section-heading">
            <h2>复制给 Agent</h2>
            <span>{platform.sharePort.label}</span>
          </div>
          {editableBall ? (
            <div className="rule-copy-layout">
              <BallSelector />
              <div className="agent-copy-card">
                <span className="ball-avatar" style={{ background: editableBall.appearance.color, borderColor: editableBall.appearance.accentColor }} />
                <div>
                  <h3>{editableBall.name}</h3>
                  <p>当前技能：{editableBall.skillLabel}。复制后交给 Agent，由 Agent 决定行为、技能、战略和移动方向。</p>
                </div>
                <button className="copy-action" onClick={copyAiPacket} type="button">
                  {copied ? <Check size={15} /> : <Copy size={15} />}
                  {copied ? "已复制" : "复制给 Agent"}
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
  const [privacyOpen, setPrivacyOpen] = useState(false);

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
        <div className="privacy-entry">
          <button onClick={() => setPrivacyOpen(true)} type="button">登录即代表同意隐私协议</button>
        </div>
      </section>
      {privacyOpen && <PrivacyModal onClose={() => setPrivacyOpen(false)} />}
    </main>
  );
}

function PrivacyModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="privacy-modal-backdrop" role="presentation">
      <section aria-modal="true" className="privacy-modal" role="dialog" aria-labelledby="privacy-title">
        <div className="privacy-modal-head">
          <div>
            <span>隐私协议</span>
            <h2 id="privacy-title">漫画版说明</h2>
          </div>
          <button aria-label="关闭隐私协议" onClick={onClose} type="button">关闭</button>
        </div>
        <img alt="agenty.cloud 隐私协议六格漫画说明" className="privacy-comic" src={privacyComicUrl} />
        <div className="privacy-summary">
          <strong>简短版</strong>
          <span>我们用邮箱完成登录，用球球和比赛数据保存你的资产与战报，不公开邮箱、不出售数据。</span>
          <span>验证码保存约 10 分钟，登录状态约 30 天；你可以通过 login@agenty.cloud 请求查询、更正或删除数据。</span>
        </div>
        <div className="privacy-actions">
          <a download="agenty-cloud-privacy-policy.md" href={privacyPolicyDownloadUrl}>下载隐私协议源文件</a>
          <button onClick={onClose} type="button">我知道了</button>
        </div>
      </section>
    </div>
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
        <MetricMini label="技能" value={ball.skillLabel} />
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

function canOpenMatchReplay(match: PlatformMatchRecord): boolean {
  return Boolean(match.replayFile?.startsWith("/api/platform/replays/") && (match.source === "auto" || match.eventId));
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return `${date.getMonth() + 1}月${date.getDate()}日 ${date.getHours().toString().padStart(2, "0")}:${date
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
}

function EventActivityView({
  currentUser,
  operation,
  platform,
  onJoinEvent,
}: {
  currentUser: AuthUser;
  operation: string | null;
  platform: PlatformSnapshot;
  onJoinEvent: () => void;
}) {
  const myBallCount = platform.balls.filter((ball) => ball.ownerId === currentUser.userId).length;
  const joined = platform.event.participantUserIds.includes(currentUser.userId);
  const canJoin = myBallCount > 0;
  const latestEvent = platform.matches.find((match) => match.source === "event");
  const statusText = platform.event.status === "active" ? "进行中" : platform.event.status === "finished" ? "已结束" : "未开始";
  return (
    <section className="wide-grid">
      <div className="content-panel span-12 event-activity">
        <div>
          <span className="event-kicker">{platform.event.label}</span>
          <h2>24 小时连续赛事</h2>
          <p>报名后进入赛事小组；后台 Worker 会持续开局，第一局结束后继续下一局，直到 24 小时结束。</p>
        </div>
        <div className="event-activity-meta">
          <MetricMini label="赛事状态" value={statusText} />
          <MetricMini label="参赛球球" value={`${platform.event.participantBallIds.length} 个`} />
          <MetricMini label="已开局" value={`${platform.event.roundCount} 局`} />
          <MetricMini label="我的球球" value={`${myBallCount} 个`} />
          <MetricMini label="最近赛事" value={latestEvent ? formatDate(latestEvent.createdAt) : "暂无"} />
          <MetricMini label="结束时间" value={platform.event.endsAt ? formatDate(platform.event.endsAt) : "待开始"} />
        </div>
        <button disabled={!canJoin || operation === "event"} onClick={onJoinEvent} type="button">
          <Play size={16} />
          {operation === "event" ? "报名中" : joined ? "已参加赛事" : "参加赛事"}
        </button>
      </div>
      {platform.event.standings.length > 0 && (
        <div className="content-panel span-12">
          <div className="section-heading">
            <h2>赛事总榜</h2>
            <span>{platform.event.roundCount} 局累计</span>
          </div>
          <div className="ranking-table event-standings-table">
            <div className="ranking-row ranking-head">
              <span>名次</span>
              <span>球球</span>
              <span>用户</span>
              <span>总分</span>
              <span>胜场</span>
              <span>均名</span>
              <span>吞噬</span>
            </div>
            {platform.event.standings.map((row, index) => (
              <div className="ranking-row" key={row.ballId}>
                <span>{index + 1}</span>
                <strong>{row.ballName}</strong>
                <span>{row.ownerName}</span>
                <b>{formatNumber(row.score)}</b>
                <span>{row.wins}</span>
                <span>{row.matches ? formatNumber(row.avgRank, 2) : "暂无"}</span>
                <span>{row.kills}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function MatchRecordsView({
  operation,
  platform,
  onOpenMatchReplay,
  onSelectBall,
}: {
  operation: string | null;
  platform: PlatformSnapshot;
  onOpenMatchReplay: (matchId: string) => void;
  onSelectBall: (ballId: string) => void;
}) {
  return (
    <section className="wide-grid">
      <div className="content-panel span-12">
        <div className="section-heading">
          <h2>完整对战记录</h2>
          <span>{platform.matches.length} 局</span>
        </div>
        {platform.matches.length > 0 ? (
          <div className="match-card-list">
            {platform.matches.map((match) => (
              <article className="match-card" key={match.matchId}>
                <div className="match-card-head">
                  <span>{match.roundIndex ? `第 ${match.roundIndex} 局` : match.eventName ?? (match.source === "auto" ? "自动赛" : "平台对局")}</span>
                  <strong>{formatDate(match.createdAt)}</strong>
                  <b>胜者 {winnerName(platform, match.winnerBallId)}</b>
                  <button
                    disabled={operation === "replay" || !canOpenMatchReplay(match)}
                    onClick={() => onOpenMatchReplay(match.matchId)}
                    title={canOpenMatchReplay(match) ? "观看这局完整回放" : "这条旧记录没有独立回放"}
                    type="button"
                  >
                    <Eye size={15} />
                    观看本局
                  </button>
                </div>
                <div className="match-result-list">
                  {match.results.map((result) => (
                    <button key={`${match.matchId}-${result.ballId}`} onClick={() => onSelectBall(result.ballId)} type="button">
                      <span>#{result.rank}</span>
                      <strong>{result.ballName}</strong>
                      <em>{result.ownerName}</em>
                      <b>{formatNumber(result.score)}</b>
                    </button>
                  ))}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyPanel text="还没有赛事记录。" />
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
