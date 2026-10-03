export type ProjectPolicy = "create" | "existing";
export type WorkspaceMode = "repo" | "folder";
export type OpenMode = "auto" | "desktop" | "browser" | "none";
export type ThreadEnvMode = "t3" | "local" | "worktree";
export type EffectiveThreadEnvMode = Exclude<ThreadEnvMode, "t3">;
export type RuntimeMode = "approval-required" | "auto" | "auto-accept-edits" | "full-access";
export type InteractionMode = "default" | "plan";
export type SpeedMode = "standard" | "fast";

/** The orchestration protocol this CLI speaks. T3 builds before orchestrator V2 speak protocol 1. */
export const ORCHESTRATION_PROTOCOL_VERSION = 2;
export const ORCHESTRATION_PROTOCOL_HEADER = "x-t3-orchestration-protocol";
export const ORCHESTRATION_PROTOCOL_QUERY_PARAM = "orchestrationProtocol";

export interface CliConfig {
  projectPolicy: ProjectPolicy;
  workspaceMode: WorkspaceMode;
  openMode: OpenMode;
  threadEnvMode: ThreadEnvMode;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  sessionTtl: string;
  provider?: string;
  model?: string;
  speedMode?: SpeedMode;
  thinkingEffort?: string;
  t3Home?: string;
  origin?: string;
  t3Command?: string[];
}

export interface RuntimeState {
  version: 1;
  pid: number;
  host?: string;
  port: number;
  origin: string;
  startedAt: string;
}

export interface T3Runtime {
  origin: string;
  stateDir: string | null;
  runtimeStatePath: string | null;
  settingsPath: string | null;
  environmentId: string;
  serverVersion: string;
  /** Null when the server does not report it; T3 builds before orchestrator V2 report 1. */
  orchestrationProtocolVersion: number | null;
  capabilities: {
    threadSettlement?: boolean;
    [key: string]: unknown;
  };
}

export interface ModelSelection {
  instanceId: string;
  model: string;
  options?: ProviderOptionSelection[];
}

export interface ProviderOptionSelection {
  id: string;
  value: string | boolean;
}

export interface T3Project {
  id: string;
  title: string;
  workspaceRoot: string;
  defaultModelSelection: ModelSelection | null;
  defaultThreadEnvMode?: EffectiveThreadEnvMode | null;
  deletedAt?: string | null;
  [key: string]: unknown;
}

/** Orchestrator V2 run lifecycle. One run is one counted turn of a thread. */
export type RunStatus =
  | "preparing"
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "interrupted"
  | "failed"
  | "cancelled"
  | "rolled_back";

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ["preparing", "starting", "running", "waiting"];
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
];

/** A thread as the V2 shell snapshot lists it: settings, lifecycle, and a summary of its live work. */
export interface T3ThreadShell {
  id: string;
  projectId: string;
  title: string;
  modelSelection?: ModelSelection;
  runtimeMode?: RuntimeMode;
  interactionMode?: InteractionMode;
  branch?: string | null;
  worktreePath?: string | null;
  status?: "idle" | RunStatus;
  activeRunId?: string | null;
  latestRunId?: string | null;
  lastError?: string | null;
  pendingRuntimeRequest?: { id: string; kind: string; createdAt: string } | null;
  createdAt?: string;
  updatedAt?: string;
  archivedAt: string | null;
  settledOverride?: "settled" | "active" | null;
  settledAt?: string | null;
  unsettledAt?: string | null;
  snoozedUntil?: string | null;
  pinnedAt?: string | null;
  latestUserMessageAt?: string | null;
  deletedAt?: string | null;
  [key: string]: unknown;
}

export interface T3ShellSnapshot {
  snapshotSequence: number;
  projects: T3Project[];
  threads: T3ThreadShell[];
  archivedThreads: T3ThreadShell[];
}

/** The thread record inside a V2 thread projection. */
export interface T3AppThread {
  id: string;
  projectId: string;
  title: string;
  modelSelection?: ModelSelection;
  runtimeMode?: RuntimeMode;
  interactionMode?: InteractionMode;
  branch?: string | null;
  worktreePath?: string | null;
  createdAt?: string;
  updatedAt?: string;
  archivedAt: string | null;
  settledOverride?: "settled" | "active" | null;
  settledAt?: string | null;
  unsettledAt?: string | null;
  snoozedUntil?: string | null;
  pinnedAt?: string | null;
  deletedAt?: string | null;
  forkedFrom?: { type: string; threadId?: string; runId?: string; [key: string]: unknown } | null;
  lineage?: { parentThreadId?: string | null; relationshipToParent?: string | null; [key: string]: unknown };
  [key: string]: unknown;
}

export interface T3Run {
  id: string;
  threadId: string;
  ordinal: number;
  providerInstanceId?: string;
  modelSelection?: ModelSelection;
  userMessageId: string;
  rootNodeId?: string | null;
  status: RunStatus;
  queuePosition?: number | null;
  queueHeld?: boolean;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  checkpointId?: string | null;
  [key: string]: unknown;
}

export interface T3RuntimeRequest {
  id: string;
  nodeId?: string | null;
  kind: string;
  status: "pending" | "resolved" | "expired" | "cancelled";
  responseCapability: { type: "live" | "message" | "not_resumable"; reason?: string; [key: string]: unknown };
  createdAt: string;
  resolvedAt: string | null;
  decision?: string;
  answers?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface T3Message {
  id: string;
  /** The run that handled the message; null for history imported from orchestrator V1. */
  runId: string | null;
  role: "user" | "assistant" | "system" | "reasoning";
  text: string;
  streaming: boolean;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

/** One entry of a V2 run's timeline: a message, tool call, request, plan, notice, or checkpoint. */
export interface T3TurnItem {
  id: string;
  type: string;
  runId: string | null;
  status?: string;
  title?: string | null;
  ordinal?: number;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface T3ThreadProjection {
  thread: T3AppThread;
  runs: T3Run[];
  runtimeRequests: T3RuntimeRequest[];
  messages: T3Message[];
  turnItems: T3TurnItem[];
  plans?: unknown[];
  checkpoints?: unknown[];
  updatedAt?: string;
  [key: string]: unknown;
}

export interface ThreadDetailSnapshot {
  snapshotSequence: number;
  projection: T3ThreadProjection;
}

export interface OpenResult {
  mode: OpenMode;
  kind: "thread-deep-link" | "desktop-reveal" | "browser" | "none";
  url: string | null;
  exactThread: boolean;
}

export interface WorkspaceResolution {
  inputPath: string;
  workspaceRoot: string;
  mode: WorkspaceMode;
  isGitRepository: boolean;
  branch: string | null;
  /** The main checkout when `workspaceRoot` is a linked Git worktree in repo mode; otherwise null. */
  mainWorktreeRoot: string | null;
}
