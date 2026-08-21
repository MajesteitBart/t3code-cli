export type ProjectPolicy = "create" | "existing";
export type WorkspaceMode = "repo" | "folder";
export type OpenMode = "auto" | "desktop" | "browser" | "none";
export type ThreadEnvMode = "t3" | "local" | "worktree";
export type EffectiveThreadEnvMode = Exclude<ThreadEnvMode, "t3">;
export type RuntimeMode = "approval-required" | "auto-accept-edits" | "full-access";
export type InteractionMode = "default" | "plan";
export type SpeedMode = "standard" | "fast";

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

export interface T3Thread {
  id: string;
  projectId: string;
  title: string;
  archivedAt: string | null;
  [key: string]: unknown;
}

export interface OrchestrationSnapshot {
  snapshotSequence: number;
  projects: T3Project[];
  threads: T3Thread[];
  updatedAt: string;
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
}
