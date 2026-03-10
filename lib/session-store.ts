import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { db } from '@/lib/db/kysely';
import { getRepositoryById, type AllowedRepository } from '@/lib/repositories';
import { getAheadBehind, getLastCommit, repoToDirName, runCommand } from '@/lib/git';

export type SessionStatus = 'creating' | 'active' | 'submitting' | 'archived' | 'error';
export type CreationStatus = 'creating' | 'active' | 'error';

export interface SessionItem {
  id: string;
  status: SessionStatus;
  repositoryId: string;
  repoFullName: string;
  baseBranch: string;
  branch: string;
  worktreePath: string;
  devServerPort: number;
  previewPath: string;
  commitCount: number;
  prUrl: string | null;
  lastCommit: { message: string; hash: string; date: string } | null;
  ahead: number;
  behind: number;
  createdAt: string;
}

export interface SessionCreationItem {
  id: string;
  status: CreationStatus;
  repositoryId: string;
  baseBranch: string;
  currentStep: string;
  steps: string[];
  sessionId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

type LocalRuntime = {
  kind: 'local';
  child: ChildProcessByStdio<null, Readable, Readable>;
  logs: string[];
};

type DockerRuntime = {
  kind: 'docker';
  containerName: string;
};

const sessionRuntimes = new Map<string, LocalRuntime | DockerRuntime>();

function dbRowToSessionItem(row: {
  sessionId: string;
  status: string;
  repositoryId: string;
  repoFullName: string;
  baseBranch: string;
  branch: string;
  worktreePath: string;
  devServerPort: number;
  previewPath: string;
  commitCount: number;
  prUrl: string | null;
  createdAt: Date;
}): SessionItem {
  return {
    id: row.sessionId,
    status: row.status as SessionStatus,
    repositoryId: row.repositoryId,
    repoFullName: row.repoFullName,
    baseBranch: row.baseBranch,
    branch: row.branch,
    worktreePath: row.worktreePath,
    devServerPort: row.devServerPort,
    previewPath: row.previewPath,
    commitCount: row.commitCount,
    prUrl: row.prUrl,
    lastCommit: null,
    ahead: 0,
    behind: 0,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

function dbRowToCreationItem(row: {
  id: string;
  status: string;
  repositoryId: string;
  baseBranch: string;
  currentStep: string;
  steps: string[];
  sessionId: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}): SessionCreationItem {
  return {
    id: row.id,
    status: row.status as CreationStatus,
    repositoryId: row.repositoryId,
    baseBranch: row.baseBranch,
    currentStep: row.currentStep,
    steps: row.steps,
    sessionId: row.sessionId,
    error: row.error,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logCreation(job: SessionCreationItem, message: string) {
  const ts = new Date().toISOString();
  console.log(`[session:create][${ts}][creation:${job.id}] ${message}`);
}

function getCloneBaseDir() {
  return process.env.CLONE_BASE_DIR || path.resolve(process.cwd(), 'data/repos');
}

function getWorktreeBaseDir() {
  return process.env.WORKTREE_BASE_DIR || path.resolve(process.cwd(), 'data/worktrees');
}

function getPortRange() {
  const start = Number(process.env.DEV_SERVER_PORT_START || '3401');
  const end = Number(process.env.DEV_SERVER_PORT_END || '3499');
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= 0 || start > end) {
    throw new Error('invalid DEV_SERVER_PORT_START/DEV_SERVER_PORT_END range');
  }
  return { start, end };
}

function getRemoteUrl(fullName: string) {
  if (process.env.GITHUB_TOKEN) {
    return `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${fullName}.git`;
  }
  return `https://github.com/${fullName}.git`;
}

async function pushStep(job: SessionCreationItem, step: string) {
  job.currentStep = step;
  job.steps.push(step);
  job.updatedAt = new Date().toISOString();
  await db
    .updateTable('sessionCreation')
    .set({
      currentStep: step,
      steps: JSON.stringify(job.steps),
      updatedAt: job.updatedAt,
    })
    .where('id', '=', job.id)
    .execute();
  logCreation(job, step);
}

function resolveCwd(base: string, relative?: string) {
  if (!relative) return base;
  return path.resolve(base, relative);
}

function findStartCwd(worktreePath: string, configured?: string) {
  const candidates: string[] = [];
  if (configured) candidates.push(resolveCwd(worktreePath, configured));
  candidates.push(worktreePath);
  candidates.push(resolveCwd(worktreePath, 'apps/manager-next'));
  for (const cwd of candidates) {
    if (!fs.existsSync(cwd)) continue;
    if (fs.existsSync(path.join(cwd, 'package.json'))) return cwd;
  }
  return null;
}

async function ensureMirrorClone(repoFullName: string) {
  const cloneBaseDir = getCloneBaseDir();
  fs.mkdirSync(cloneBaseDir, { recursive: true });
  const mirrorPath = path.join(cloneBaseDir, `${repoToDirName(repoFullName)}.git`);
  if (!fs.existsSync(mirrorPath)) {
    await runCommand('git', ['clone', '--mirror', getRemoteUrl(repoFullName), mirrorPath]);
  }
  await runCommand('git', ['--git-dir', mirrorPath, 'fetch', 'origin', '--prune']);
  return mirrorPath;
}

async function createWorktree(params: {
  mirrorPath: string;
  repositoryId: string;
  baseBranch: string;
  sessionId: string;
}) {
  const { mirrorPath, repositoryId, baseBranch, sessionId } = params;
  const worktreeBaseDir = getWorktreeBaseDir();
  fs.mkdirSync(worktreeBaseDir, { recursive: true });
  const branch = `design/${repositoryId}-${sessionId.slice(0, 8)}`;
  const worktreePath = path.join(worktreeBaseDir, `${repositoryId}-${sessionId}`);
  const localHeadRef = `refs/heads/${baseBranch}`;
  const remoteRef = `refs/remotes/origin/${baseBranch}`;
  let baseRefForWorktree = localHeadRef;
  try {
    await runCommand('git', ['--git-dir', mirrorPath, 'show-ref', '--verify', localHeadRef]);
  } catch {
    try {
      await runCommand('git', ['--git-dir', mirrorPath, 'show-ref', '--verify', remoteRef]);
      baseRefForWorktree = remoteRef;
    } catch {
      throw new Error(`base branch not found in mirror: ${baseBranch}`);
    }
  }
  await runCommand('git', ['--git-dir', mirrorPath, 'worktree', 'add', '-b', branch, worktreePath, baseRefForWorktree]);
  return { branch, worktreePath };
}

function isPortBusy(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => { server.close(() => resolve(false)); });
    server.listen(port, '127.0.0.1');
  });
}

async function allocatePort() {
  const { start, end } = getPortRange();
  const usedPorts = await db
    .selectFrom('session')
    .select('devServerPort')
    .where('status', '!=', 'archived')
    .execute();
  const used = new Set(usedPorts.map((r) => r.devServerPort));
  for (let port = start; port <= end; port += 1) {
    if (used.has(port)) continue;
    const busy = await isPortBusy(port);
    if (!busy) return port;
  }
  throw new Error(`no available port in range ${start}-${end}`);
}

function applyPort(args: string[], port: number) {
  return args.map((arg) => arg.replaceAll('{port}', String(port)));
}

type DockerLogMonitor = { stop: () => Promise<void>; getRecentLogs: () => string[] };

function createDockerLogMonitor(params: { containerName: string; job: SessionCreationItem }): DockerLogMonitor {
  const { containerName, job } = params;
  const recentLogs: string[] = [];
  const emittedSteps = new Set<string>();
  let rawLogCount = 0;
  const emitStep = (step: string) => {
    if (emittedSteps.has(step)) return;
    emittedSteps.add(step);
    void pushStep(job, step);
  };
  const child = spawn('docker', ['logs', '-f', '--tail', '80', containerName], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const onLine = (line: string) => {
    const text = line.trim();
    if (!text) return;
    recentLogs.push(text);
    if (recentLogs.length > 240) recentLogs.shift();
    const lower = text.toLowerCase();
    if (lower.includes('pnpm install') || lower.includes('npm install') || lower.includes('yarn install')) {
      emitStep('컨테이너: 의존성 설치 진행 중...'); return;
    }
    if (lower.includes('pnpm run build') || lower.includes('npm run build') || lower.includes(' build ') || lower.includes('building')) {
      emitStep('컨테이너: 빌드 단계 진행 중...'); return;
    }
    if (lower.includes('ready') || lower.includes('listening') || lower.includes('started server') || lower.includes('local:') || lower.includes('compiled')) {
      emitStep(`컨테이너: 서버 기동 로그 감지 (${text.slice(0, 90)})`); return;
    }
    if (lower.includes('error') || lower.includes('err_') || lower.includes('failed') || lower.includes('exception')) {
      emitStep(`컨테이너 로그 오류 감지: ${text.slice(0, 120)}`); return;
    }
    if (rawLogCount < 8) { rawLogCount += 1; emitStep(`컨테이너 로그: ${text.slice(0, 120)}`); }
  };
  const wireStream = (stream: Readable) => {
    let buffered = '';
    stream.on('data', (chunk) => {
      buffered += String(chunk);
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() || '';
      for (const line of lines) onLine(line);
    });
    stream.on('end', () => { if (buffered.trim()) onLine(buffered); });
  };
  wireStream(child.stdout);
  wireStream(child.stderr);
  const stop = async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await sleep(200); if (child.exitCode === null) child.kill('SIGKILL'); }
  };
  return { stop, getRecentLogs: () => [...recentLogs] };
}

function shellQuote(value: string) { return `'${value.replaceAll("'", `'\"'\"'`)}'`; }
function getRuntimeMode() { return (process.env.SESSION_RUNTIME || 'docker').toLowerCase(); }
function getDockerImage() { return process.env.DOCKER_IMAGE || 'workspace-runtime'; }
function getDockerInternalPort() {
  const port = Number(process.env.DOCKER_INTERNAL_PORT || '3001');
  if (!Number.isFinite(port) || port <= 0) throw new Error('invalid DOCKER_INTERNAL_PORT');
  return port;
}
function getDockerContextPath() { return process.env.DOCKER_BUILD_CONTEXT || path.resolve(process.cwd(), 'apps/workspace'); }
function getDockerfilePath() { return process.env.DOCKERFILE_PATH || path.join(getDockerContextPath(), 'Dockerfile'); }
function getSessionContainerName(sessionId: string) { return `dp-session-${sessionId.slice(0, 12)}`; }

async function ensureDockerReady(job: SessionCreationItem) {
  await pushStep(job, 'docker 엔진 확인 중...');
  await runCommand('docker', ['version']);
  const image = getDockerImage();
  const inspect = await runCommand('docker', ['image', 'inspect', image]).catch(() => null);
  if (inspect) return image;
  const contextPath = getDockerContextPath();
  const dockerfilePath = getDockerfilePath();
  await pushStep(job, `docker 이미지 빌드 중... (${image})`);
  await runCommand('docker', ['build', '-t', image, '-f', dockerfilePath, contextPath]);
  return image;
}

function buildContainerScript(repo: AllowedRepository, internalPort: number) {
  const start = applyPort(repo.devServer.start, internalPort).map(shellQuote).join(' ');
  const install = repo.devServer.install && repo.devServer.install.length > 0
    ? `${applyPort(repo.devServer.install, internalPort).map(shellQuote).join(' ')}` : null;
  const build = repo.devServer.build && repo.devServer.build.length > 0
    ? `${applyPort(repo.devServer.build, internalPort).map(shellQuote).join(' ')}` : null;
  const lines = ['set -e', 'cd /workspace'];
  if (install) lines.push(`CI=true GIT_TERMINAL_PROMPT=0 ${install}`);
  if (build) lines.push(`(CI=true GIT_TERMINAL_PROMPT=0 ${build}) || true`);
  lines.push(`exec CI= ${start}`);
  return lines.join('\n');
}

async function waitForHttpReady(params: { port: number; readyPath: string; timeoutMs?: number; onTimeout?: () => Promise<string> }) {
  const { port, readyPath } = params;
  const timeoutMs = params.timeoutMs ?? 180_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${readyPath}`, { cache: 'no-store' });
      if (res.ok || res.status < 500) return;
    } catch { /* retry */ }
    await sleep(900);
  }
  const detail = params.onTimeout ? await params.onTimeout() : 'no logs captured';
  throw new Error(`dev server readiness timeout on port ${port}\n${detail}`);
}

function attachLogs(sessionId: string, child: ChildProcessByStdio<null, Readable, Readable>, logs: string[]) {
  const onChunk = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
    const text = String(chunk);
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const entry = `[${stream}] ${line}`;
      logs.push(entry);
      if (logs.length > 200) logs.shift();
      console.log(`[dev:${sessionId}] ${entry}`);
    }
  };
  child.stdout.on('data', (chunk) => onChunk(chunk, 'stdout'));
  child.stderr.on('data', (chunk) => onChunk(chunk, 'stderr'));
}

function startLocalProcess(params: { sessionId: string; repo: AllowedRepository; worktreePath: string; port: number; command: string[] }) {
  const { sessionId, repo, worktreePath, port, command } = params;
  const [cmd, ...args] = applyPort(command, port);
  if (!cmd) throw new Error('invalid start command');
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('__NEXT') && !key.startsWith('__TURBO') && key !== 'TURBOPACK')
  );
  const env: NodeJS.ProcessEnv = {
    ...cleanEnv, ...repo.devServer.extraEnv,
    NODE_ENV: 'development', PORT: String(port), APP_PORT: String(port), NEXT_PORT: String(port), BROWSER: 'none', CI: process.env.CI || 'true'
  };
  const child = spawn(cmd, args, { cwd: worktreePath, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs: string[] = [];
  attachLogs(sessionId, child, logs);
  return { kind: 'local' as const, child, logs };
}

function summarizeLogs(logs: string[]) {
  if (logs.length === 0) return 'no logs captured';
  return logs.slice(-40).join('\n');
}

async function waitForReady(params: { port: number; readyPath: string; child: ChildProcessByStdio<null, Readable, Readable>; logs: string[]; timeoutMs?: number }) {
  const { port, readyPath, child, logs } = params;
  const timeoutMs = params.timeoutMs ?? 180_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`dev server exited before ready (code=${child.exitCode})\n${summarizeLogs(logs)}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}${readyPath}`, { cache: 'no-store' });
      if (res.status > 0) return;
    } catch { /* retry */ }
    await sleep(900);
  }
  throw new Error(`dev server readiness timeout on port ${port}\n${summarizeLogs(logs)}`);
}

async function setupRepoSteps(params: { repo: AllowedRepository; worktreePath: string; port: number; job: SessionCreationItem }) {
  const { repo, worktreePath, port, job } = params;
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('__NEXT') && !key.startsWith('__TURBO') && key !== 'TURBOPACK')
  );
  const env: NodeJS.ProcessEnv = {
    ...cleanEnv, ...repo.devServer.extraEnv,
    NODE_ENV: 'development', PORT: String(port), APP_PORT: String(port), NEXT_PORT: String(port), BROWSER: 'none', CI: process.env.CI || 'true'
  };
  if (repo.devServer.install && repo.devServer.install.length > 0) {
    await pushStep(job, `의존성 설치 중... (${repo.devServer.install.join(' ')})`);
    const [cmd, ...args] = applyPort(repo.devServer.install, port);
    await runCommand(cmd, args, { cwd: resolveCwd(worktreePath, repo.devServer.installCwd), env });
  }
  if (repo.devServer.build && repo.devServer.build.length > 0) {
    await pushStep(job, `빌드 중... (${repo.devServer.build.join(' ')})`);
    const [cmd, ...args] = applyPort(repo.devServer.build, port);
    try {
      await runCommand(cmd, args, { cwd: resolveCwd(worktreePath, repo.devServer.installCwd), env });
    } catch (error) {
      const msg = error instanceof Error ? error.message.split('\n').slice(0, 8).join('\n') : 'unknown build error';
      await pushStep(job, `빌드 실패(계속 진행): ${msg}`);
      console.error(`[session:create][build:warn] ${msg}`);
    }
  }
}

async function startLocalDevServer(params: { sessionId: string; repo: AllowedRepository; worktreePath: string; port: number; job: SessionCreationItem }) {
  const { sessionId, repo, worktreePath, port, job } = params;
  const startCwd = findStartCwd(worktreePath, repo.devServer.startCwd);
  if (!startCwd) throw new Error(`startCwd not found. configured=${repo.devServer.startCwd ?? '(root)'} root=${worktreePath}`);
  const runRoot = worktreePath;
  if (!fs.existsSync(runRoot)) throw new Error(`worktree path not found: ${runRoot}`);
  await setupRepoSteps({ repo, worktreePath: runRoot, port, job });
  const readyPath = repo.devServer.readyPath || '/';
  await pushStep(job, `개발서버 실행 중... (${repo.devServer.start.join(' ')})`);
  let runtime = startLocalProcess({ sessionId, repo, worktreePath: runRoot, port, command: repo.devServer.start });
  try {
    await waitForReady({ port, readyPath, child: runtime.child, logs: runtime.logs, timeoutMs: 120_000 });
    return runtime;
  } catch (firstError) {
    if (runtime.child.exitCode === null) { runtime.child.kill('SIGTERM'); await sleep(500); if (runtime.child.exitCode === null) runtime.child.kill('SIGKILL'); }
    if (!repo.devServer.fallbackStart || repo.devServer.fallbackStart.length === 0) throw firstError;
    await pushStep(job, `1차 실행 실패, fallback 실행 중... (${repo.devServer.fallbackStart.join(' ')})`);
    runtime = startLocalProcess({ sessionId, repo, worktreePath: runRoot, port, command: repo.devServer.fallbackStart });
    await waitForReady({ port, readyPath, child: runtime.child, logs: runtime.logs, timeoutMs: 120_000 });
    return runtime;
  }
}

async function startDockerDevServer(params: { sessionId: string; repo: AllowedRepository; worktreePath: string; mirrorPath: string; port: number; job: SessionCreationItem }) {
  const { sessionId, repo, worktreePath, mirrorPath, port, job } = params;
  if (!fs.existsSync(worktreePath)) throw new Error(`worktree path not found: ${worktreePath}`);
  const image = await ensureDockerReady(job);
  const internalPort = getDockerInternalPort();
  const containerName = getSessionContainerName(sessionId);
  const script = buildContainerScript(repo, internalPort);
  await pushStep(job, `docker 컨테이너 시작 중... (${containerName})`);
  await runCommand('docker', ['rm', '-f', containerName]).catch(() => null);
  await pushStep(job, 'docker gitdir 마운트 설정 중...');
  const envArgs: string[] = [
    '-e', `NODE_ENV=development`, '-e', `PORT=${internalPort}`, '-e', `APP_PORT=${internalPort}`,
    '-e', `NEXT_PORT=${internalPort}`, '-e', `BROWSER=none`, '-e', `CI=${process.env.CI || 'true'}`
  ];
  for (const [key, value] of Object.entries(repo.devServer.extraEnv || {})) envArgs.push('-e', `${key}=${value}`);
  await runCommand('docker', [
    'run', '-d', '--name', containerName, '-p', `${port}:${internalPort}`,
    '-v', `${worktreePath}:/workspace`, '-v', `${mirrorPath}:${mirrorPath}`, '-w', '/workspace',
    ...envArgs, '--entrypoint', 'sh', image, '-lc', script
  ]);
  const readyPath = repo.devServer.readyPath || '/';
  const monitor = createDockerLogMonitor({ containerName, job });
  try {
    await waitForHttpReady({
      port, readyPath, timeoutMs: 120_000,
      onTimeout: async () => {
        const buffered = monitor.getRecentLogs().slice(-60).join('\n');
        const out = await runCommand('docker', ['logs', '--tail', '120', containerName]).catch((error) => ({
          stdout: '', stderr: error instanceof Error ? error.message : 'failed to read docker logs'
        }));
        return `${buffered}\n${out.stdout}\n${out.stderr}`.trim() || 'no logs captured';
      }
    });
  } finally { await monitor.stop(); }
  return { kind: 'docker' as const, containerName };
}

// ---------------------------------------------------------------------------
// Public API — all async, backed by DB
// ---------------------------------------------------------------------------

export async function startSessionCreation(input: { repositoryId: string; baseBranch: string }) {
  const repository = getRepositoryById(input.repositoryId);
  if (!repository) throw new Error('repository is not allowed');

  const creationId = randomUUID();
  const baseBranch = input.baseBranch.trim() || repository.defaultBranch;
  const now = new Date().toISOString();

  const job: SessionCreationItem = {
    id: creationId, status: 'creating', repositoryId: repository.id, baseBranch,
    currentStep: '세션 생성 준비 중...', steps: ['세션 생성 준비 중...'],
    sessionId: null, error: null, createdAt: now, updatedAt: now
  };

  await db.insertInto('sessionCreation').values({
    id: creationId, status: 'creating', repositoryId: repository.id, baseBranch,
    currentStep: '세션 생성 준비 중...', steps: JSON.stringify(['세션 생성 준비 중...']),
    createdAt: now, updatedAt: now,
  }).execute();

  logCreation(job, `start repository=${repository.fullName} baseBranch=${baseBranch}`);

  void (async () => {
    let createdWorktreePath: string | null = null;
    let createdContainerName: string | null = null;
    try {
      await pushStep(job, '저장소 clone/fetch 준비 중...');
      const mirrorPath = await ensureMirrorClone(repository.fullName);
      await pushStep(job, 'worktree 생성 중...');
      const sessionId = randomUUID();
      const { branch, worktreePath } = await createWorktree({ mirrorPath, repositoryId: repository.id, baseBranch, sessionId });
      createdWorktreePath = worktreePath;

      if (repository.envFilePath) {
        const envSrc = path.resolve(process.cwd(), repository.envFilePath);
        if (fs.existsSync(envSrc)) {
          const envDest = path.join(worktreePath, '.env.local');
          fs.copyFileSync(envSrc, envDest);
          await pushStep(job, `.env.local 복사 완료`);
        } else {
          await pushStep(job, `.env.local 템플릿 없음 (${repository.envFilePath})`);
        }
      }

      await pushStep(job, '개발서버 포트 할당 중...');
      const devServerPort = await allocatePort();

      const runtimeMode = getRuntimeMode();
      const runtime = runtimeMode === 'local'
        ? await startLocalDevServer({ sessionId, repo: repository, worktreePath, port: devServerPort, job })
        : await startDockerDevServer({ sessionId, repo: repository, worktreePath, mirrorPath, port: devServerPort, job });
      if (runtime.kind === 'docker') createdContainerName = runtime.containerName;

      // Insert session with retry for unique port constraint
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await db.insertInto('session').values({
            sessionId, userId: 'dev', status: 'active', repositoryId: repository.id,
            repoFullName: repository.fullName, baseBranch, branch, worktreePath,
            devServerPort, previewPath: `/session/${sessionId}/preview`, commitCount: 0,
          }).execute();
          break;
        } catch (err) { if (attempt === 2) throw err; }
      }

      sessionRuntimes.set(sessionId, runtime);
      job.status = 'active';
      job.sessionId = sessionId;
      await db.updateTable('sessionCreation').set({ status: 'active', sessionId }).where('id', '=', job.id).execute();
      await pushStep(job, '세션 준비 완료');
      logCreation(job, `done sessionId=${sessionId} worktree=${worktreePath} port=${devServerPort}`);
    } catch (error) {
      if (createdContainerName) await runCommand('docker', ['rm', '-f', createdContainerName]).catch(() => null);
      if (createdWorktreePath && fs.existsSync(createdWorktreePath)) {
        try { fs.rmSync(createdWorktreePath, { recursive: true, force: true }); console.log(`[session:create] cleanup worktree=${createdWorktreePath}`); }
        catch (cleanupError) { console.error(cleanupError); }
      }
      job.status = 'error';
      job.error = error instanceof Error ? error.message : 'session creation failed';
      await db.updateTable('sessionCreation').set({ status: 'error', error: job.error }).where('id', '=', job.id).execute();
      await pushStep(job, '세션 생성 실패');
      logCreation(job, `error ${job.error}`);
      console.error(error);
    }
  })();

  return job;
}

export async function getSessionCreation(id: string) {
  const row = await db.selectFrom('sessionCreation').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? dbRowToCreationItem(row) : null;
}

export async function listSessions() {
  const rows = await db.selectFrom('session').selectAll().orderBy('createdAt', 'desc').execute();
  return rows.map(dbRowToSessionItem);
}

export async function getSession(id: string) {
  const row = await db.selectFrom('session').selectAll().where('sessionId', '=', id).executeTakeFirst();
  return row ? dbRowToSessionItem(row) : null;
}

export async function getSessionPreviewTarget(id: string) {
  const row = await db.selectFrom('session').select(['devServerPort']).where('sessionId', '=', id).executeTakeFirst();
  if (!row) return null;
  return { port: row.devServerPort, baseUrl: `http://127.0.0.1:${row.devServerPort}` };
}

export async function removeSession(id: string) {
  const row = await db.selectFrom('session').selectAll().where('sessionId', '=', id).executeTakeFirst();
  if (!row) return false;
  const target = dbRowToSessionItem(row);

  const runtime = sessionRuntimes.get(id);
  if (runtime) {
    if (runtime.kind === 'local') {
      if (runtime.child.exitCode === null) { runtime.child.kill('SIGTERM'); await sleep(500); if (runtime.child.exitCode === null) runtime.child.kill('SIGKILL'); }
    } else { await runCommand('docker', ['rm', '-f', runtime.containerName]).catch(() => null); }
    sessionRuntimes.delete(id);
  } else if (getRuntimeMode() !== 'local') {
    await runCommand('docker', ['rm', '-f', getSessionContainerName(id)]).catch(() => null);
  }

  const mirrorPath = path.join(getCloneBaseDir(), `${repoToDirName(target.repoFullName)}.git`);
  try {
    await runCommand('git', ['--git-dir', mirrorPath, 'worktree', 'remove', '--force', target.worktreePath]);
    console.log(`[session:remove] sessionId=${id} worktree=${target.worktreePath}`);
  } catch {
    if (fs.existsSync(target.worktreePath)) {
      fs.rmSync(target.worktreePath, { recursive: true, force: true });
      console.log(`[session:remove] force delete sessionId=${id} worktree=${target.worktreePath}`);
    }
  }

  await db.deleteFrom('session').where('sessionId', '=', id).execute();
  return true;
}

export async function submitSession(id: string) {
  const row = await db.selectFrom('session').selectAll().where('sessionId', '=', id).executeTakeFirst();
  if (!row) return null;
  const prUrl = `https://github.com/${row.repoFullName}/compare/${row.baseBranch}...${row.branch}`;
  await db.updateTable('session').set({ status: 'archived', prUrl }).where('sessionId', '=', id).execute();
  const updated = dbRowToSessionItem(row);
  updated.status = 'archived';
  updated.prUrl = prUrl;
  return updated;
}

export async function bumpCommit(id: string) {
  const result = await db
    .updateTable('session')
    .set({ commitCount: sql`commit_count + 1` })
    .where('sessionId', '=', id)
    .returning(['sessionId', 'commitCount'])
    .executeTakeFirst();
  return result ?? null;
}

export async function enrichSessionWithGit(item: SessionItem): Promise<SessionItem> {
  const [lastCommit, aheadBehind] = await Promise.all([
    getLastCommit(item.worktreePath),
    getAheadBehind(item.worktreePath, item.baseBranch)
  ]);
  return { ...item, lastCommit, ahead: aheadBehind.ahead, behind: aheadBehind.behind };
}
