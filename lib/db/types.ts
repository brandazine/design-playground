import type { ColumnType, Generated } from 'kysely';

export interface SessionTable {
  sessionId: string;
  userId: Generated<string>;
  status: Generated<string>;
  repositoryId: string;
  repoFullName: string;
  baseBranch: string;
  branch: string;
  worktreePath: string;
  runtimePreset: Generated<string>;
  startCommand: ColumnType<string[], string | string[] | undefined, string | string[]>;
  readyPath: Generated<string>;
  processPid: number | null;
  processStatus: Generated<string>;
  lastProxyRequestAt: ColumnType<Date, Date | string | undefined, Date | string>;
  devServerPort: number;
  previewPath: string;
  commitCount: Generated<number>;
  prUrl: string | null;
  agentationSessionId: string | null;
  lastActiveAt: ColumnType<Date, Date | string | undefined, Date | string>;
  createdAt: ColumnType<Date, Date | string | undefined, Date | string>;
  expiresAt: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface SessionCreationTable {
  id: string;
  status: string;
  repositoryId: string;
  baseBranch: string;
  currentStep: string;
  steps: ColumnType<string[], string | string[], string | string[]>;
  sessionId: string | null;
  error: string | null;
  createdAt: ColumnType<Date, Date | string, Date | string>;
  updatedAt: ColumnType<Date, Date | string, Date | string>;
}

export interface CommentTable {
  commentId: string;
  sessionId: string;
  agentationAnnotationId: string | null;
  status: string;
  category: string;
  element: ColumnType<Record<string, unknown>, string | Record<string, unknown>, string | Record<string, unknown>>;
  metadata: ColumnType<Record<string, unknown>, string | Record<string, unknown>, string | Record<string, unknown>>;
  createdAt: ColumnType<Date, Date | string, Date | string>;
  resolvedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;
}

export interface CommentMessageTable {
  messageId: string;
  commentId: string;
  role: string;
  content: string;
  codeChanges: ColumnType<Record<string, unknown>[] | null, string | null, string | null>;
  createdAt: ColumnType<Date, Date | string, Date | string>;
}

export interface CommandQueueTable {
  commandId: string;
  sessionId: string;
  commentId: string | null;
  type: string;
  payload: ColumnType<Record<string, unknown>, string | Record<string, unknown>, string | Record<string, unknown>>;
  status: string;
  result: ColumnType<Record<string, unknown> | null, string | null, string | null>;
  workerId: string | null;
  createdAt: ColumnType<Date, Date | string, Date | string>;
  startedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;
  completedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;
  cancelledAt: ColumnType<Date | null, Date | string | null, Date | string | null>;
}

export interface CommandEventTable {
  id: Generated<string>;
  commandId: string;
  sessionId: string;
  eventType: string;
  payload: ColumnType<Record<string, unknown>, string | Record<string, unknown>, string | Record<string, unknown>>;
  createdAt: Generated<Date>;
}

export interface AISessionTable {
  id: string;
  sessionId: string;
  provider: string;
  providerSessionId: string;
  createdAt: ColumnType<Date, Date | string, Date | string>;
  lastUsedAt: ColumnType<Date, Date | string, Date | string>;
}

export interface WorkerRegistryTable {
  workerId: string;
  status: string;
  lastHeartbeat: ColumnType<Date, Date | string, Date | string>;
  startedAt: ColumnType<Date, Date | string, Date | string>;
  hostname: string | null;
  pid: number | null;
  metadata: ColumnType<Record<string, unknown>, string | Record<string, unknown>, string | Record<string, unknown>>;
}

export interface SessionSkillTable {
  id: string;
  sessionId: string;
  name: string;
  scope: string;
  trigger: string;
  categories: ColumnType<string[] | null, string | string[] | null, string | string[] | null>;
  instructions: string;
  priority: number;
  createdAt: ColumnType<Date, Date | string, Date | string>;
}

export interface Database {
  session: SessionTable;
  sessionCreation: SessionCreationTable;
  comment: CommentTable;
  commentMessage: CommentMessageTable;
  commandQueue: CommandQueueTable;
  commandEvent: CommandEventTable;
  aiSession: AISessionTable;
  workerRegistry: WorkerRegistryTable;
  sessionSkill: SessionSkillTable;
}
