import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { bumpCommit, getSession } from '@/lib/session-store';
import { runCommand } from '@/lib/git';
import {
  addCommentMessage,
  appendCommandEvent,
  completeCommand,
  failCommand,
  findStuckCommands,
  getComment,
  listCommands,
  setCommentStatus,
  takeNextQueuedCommand,
  type Command
} from '@/lib/comment-store';
import { checkAutoResolve } from '@/lib/auto-resolve';
import { resolveAnnotation } from '@/lib/annotation-poller';

const execFileAsync = promisify(execFile);
const DEFAULT_POLL_MS = 500;
const COMMAND_TIMEOUT_MS = Number(process.env.AGENT_COMMAND_TIMEOUT_MS || '300000');
const CLAUDE_PATH = process.env.CLAUDE_CLI_PATH || '/opt/homebrew/bin/claude';
const CLAUDE_MODEL = process.env.CLAUDE_AGENT_MODEL || 'sonnet';

let started = false;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildElementContext(
  element?: Record<string, unknown>,
  metadata?: Record<string, unknown>
): string {
  if (!element && !metadata) return '';
  const parts: string[] = [];

  if (element) {
    if (element.selector) parts.push(`CSS Selector: ${element.selector}`);
    if (element.tagName) parts.push(`Tag: ${element.tagName}`);
    if (element.className) parts.push(`Class: ${element.className}`);
    if (element.componentName) parts.push(`Component: ${element.componentName}`);
    if (element.componentPath) parts.push(`Component Path: ${element.componentPath}`);
  }

  if (metadata && typeof metadata === 'object') {
    const styles = (metadata as Record<string, unknown>).computedStyles;
    if (styles && typeof styles === 'object') {
      const relevant = Object.entries(styles as Record<string, string>)
        .filter(([, v]) => v && v !== 'none' && v !== 'normal' && v !== 'auto')
        .map(([k, v]) => `  ${k}: ${v}`)
        .join('\n');
      if (relevant) parts.push(`Current Computed Styles:\n${relevant}`);
    }
  }

  return parts.join('\n');
}

function getCleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const exclude = new Set([
    'TURBOPACK',
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_PARENT_SESSION_ID'
  ]);
  for (const [key, value] of Object.entries(process.env)) {
    if (
      !key.startsWith('__NEXT') &&
      !key.startsWith('__TURBO') &&
      !exclude.has(key)
    ) {
      env[key] = value;
    }
  }
  return env;
}

function findRelevantFiles(worktreePath: string, message: string): string[] {
  // Map Korean terms to English file names
  const termMap: Record<string, string[]> = {
    '로그인': ['login'],
    '회원가입': ['signup', 'register'],
    '홈': ['home', 'index'],
    '대시보드': ['dashboard', 'home'],
    '설정': ['settings', 'config'],
    '프로필': ['profile'],
    'login': ['login'],
    'signup': ['signup'],
    'home': ['home', 'index'],
  };

  const lowerMsg = message.toLowerCase();
  const fileKeywords: string[] = [];
  for (const [term, filenames] of Object.entries(termMap)) {
    if (lowerMsg.includes(term.toLowerCase())) {
      fileKeywords.push(...filenames);
    }
  }
  if (fileKeywords.length === 0) fileKeywords.push('index');

  const pageDir = path.join(worktreePath, 'apps/manager-next/src/pages');
  const componentDir = path.join(worktreePath, 'apps/manager-next/src/components');
  const results: string[] = [];

  const searchDir = (dir: string, depth: number) => {
    if (depth > 3 || !fs.existsSync(dir)) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          searchDir(full, depth + 1);
        } else if (entry.isFile() && /\.(tsx?|jsx?)$/.test(entry.name)) {
          const nameLower = entry.name.toLowerCase().replace(/\.(tsx?|jsx?)$/, '');
          if (fileKeywords.some((kw) => nameLower.includes(kw))) {
            results.push(full);
          }
        }
      }
    } catch { /* ignore */ }
  };

  searchDir(pageDir, 0);
  if (results.length === 0) searchDir(componentDir, 0);

  return results.slice(0, 3);
}

async function executeClaudeEdit(
  worktreePath: string,
  designerMessage: string,
  elementContext: string
): Promise<{ reply: string; diff: string }> {
  console.log(`[claude-edit] Starting in ${worktreePath}`);
  console.log(`[claude-edit] Message: ${designerMessage}`);

  // Step 1: Find relevant files and read their content
  const files = findRelevantFiles(worktreePath, designerMessage);
  console.log(`[claude-edit] Found ${files.length} relevant files: ${files.map(f => path.relative(worktreePath, f)).join(', ')}`);

  let fileContext = '';
  for (const filePath of files) {
    const rel = path.relative(worktreePath, filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    fileContext += `\n--- FILE: ${rel} ---\n${content}\n`;
  }

  if (!fileContext) {
    return { reply: '관련 파일을 찾을 수 없습니다.', diff: 'no files found' };
  }

  // Step 2: Ask Claude (no tools, just text) for JSON edit instructions
  const prompt = `You are a code editor. A designer wants a visual change applied.

Feedback: "${designerMessage}"
${elementContext ? `\nElement info:\n${elementContext}` : ''}

Here are the relevant source files:
${fileContext}

Return a JSON response with this exact format (no markdown, no explanation, ONLY JSON):
{
  "edits": [
    {"file": "relative/path.tsx", "search": "exact string to find", "replace": "replacement string"}
  ],
  "summary": "Korean summary of changes"
}

Important: "search" must be an EXACT substring from the file. Keep edits minimal.`;

  let stdout = '';
  try {
    const result = await execFileAsync(CLAUDE_PATH, [
      '-p',
      prompt,
      '--dangerously-skip-permissions',
      '--model',
      CLAUDE_MODEL,
      '--output-format',
      'text',
      '--no-session-persistence'
    ], {
      cwd: worktreePath,
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
      env: getCleanEnv()
    });
    stdout = result.stdout;
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string };
    stdout = execErr.stdout || '';
    console.log(`[claude-edit] Non-zero exit. stderr=${(execErr.stderr || '').slice(0, 300)}`);
  }

  console.log(`[claude-edit] Response: ${stdout.slice(0, 500)}`);

  // Step 3: Parse JSON response and apply edits
  let edits: Array<{ file: string; search: string; replace: string }> = [];
  let summary = '';

  try {
    // Extract JSON from response (may be wrapped in markdown code block)
    const jsonMatch = stdout.match(/\{[\s\S]*"edits"[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in response');
    const parsed = JSON.parse(jsonMatch[0]);
    edits = parsed.edits || [];
    summary = parsed.summary || '';
  } catch (e) {
    console.log(`[claude-edit] Failed to parse JSON: ${e}. Raw: ${stdout.slice(0, 300)}`);
    return { reply: `파싱 실패. Claude 응답: ${stdout.slice(0, 200)}`, diff: 'parse error' };
  }

  // Step 4: Apply edits
  const applied: string[] = [];
  for (const edit of edits) {
    const targetPath = path.join(worktreePath, edit.file);
    if (!fs.existsSync(targetPath)) {
      console.log(`[claude-edit] File not found: ${edit.file}`);
      continue;
    }
    const content = fs.readFileSync(targetPath, 'utf8');
    if (!content.includes(edit.search)) {
      console.log(`[claude-edit] Search string not found in ${edit.file}: "${edit.search.slice(0, 80)}"`);
      continue;
    }
    const updated = content.replace(edit.search, edit.replace);
    fs.writeFileSync(targetPath, updated, 'utf8');
    applied.push(`${edit.file}: "${edit.search.slice(0, 40)}" → "${edit.replace.slice(0, 40)}"`);
    console.log(`[claude-edit] Applied edit to ${edit.file}`);
  }

  if (applied.length === 0) {
    return { reply: summary || '변경 사항을 적용하지 못했습니다.', diff: 'no edits applied' };
  }

  // Check for changes and commit
  await runCommand('git', ['add', '-A'], { cwd: worktreePath });

  let diff = '';
  try {
    const diffResult = await runCommand('git', ['diff', '--cached', '--stat'], {
      cwd: worktreePath
    });
    diff = diffResult.stdout.trim();
  } catch {
    diff = '';
  }

  if (diff) {
    try {
      await runCommand(
        'git',
        ['commit', '-m', `design: ${designerMessage.slice(0, 80)}`],
        { cwd: worktreePath }
      );
      console.log(`[claude-edit] Committed changes:\n${diff}`);
    } catch (e) {
      console.log(`[claude-edit] Commit failed: ${e}`);
    }
  } else {
    console.log('[claude-edit] No file changes detected after claude execution');
  }

  return {
    reply: stdout.trim() || `요청을 반영했습니다: "${designerMessage.slice(0, 180)}"`,
    diff: diff || 'no file changes detected'
  };
}

async function executeUndo(worktreePath: string): Promise<{ reply: string; diff: string }> {
  try {
    const diffResult = await runCommand('git', ['diff', 'HEAD~1', '--stat'], {
      cwd: worktreePath
    });
    await runCommand('git', ['revert', 'HEAD', '--no-edit'], { cwd: worktreePath });
    return {
      reply: '최근 커밋을 되돌렸습니다. 프리뷰에서 결과를 확인해주세요.',
      diff: diffResult.stdout || 'reverted'
    };
  } catch (e) {
    return {
      reply: '되돌리기에 실패했습니다.',
      diff: e instanceof Error ? e.message : 'revert failed'
    };
  }
}

async function processCommand(command: Command) {
  appendCommandEvent({
    sessionId: command.sessionId,
    commandId: command.id,
    type: 'step_start',
    payload: { step: 'process_command', commandType: command.type }
  });

  if (command.commentId) {
    setCommentStatus(command.sessionId, command.commentId, 'processing');
    appendCommandEvent({
      sessionId: command.sessionId,
      commandId: command.id,
      type: 'comment_update',
      payload: { commentId: command.commentId, status: 'processing' }
    });
  }

  await sleep(250);

  if (command.type === 'annotation_batch') {
    const commentIds = Array.isArray(command.payload.commentIds)
      ? command.payload.commentIds.filter((item): item is string => typeof item === 'string')
      : [];
    for (const commentId of commentIds) {
      const virtual: Command = { ...command, commentId, type: 'chat_reply' };
      await processCommentCommand(virtual);
    }
    completeCommand(command.sessionId, command.id, {
      ok: true,
      processedComments: commentIds.length
    });
    appendCommandEvent({
      sessionId: command.sessionId,
      commandId: command.id,
      type: 'step_complete',
      payload: { step: 'process_annotation_batch', count: commentIds.length }
    });
    return;
  }

  await processCommentCommand(command);

  if (command.type !== 'undo') {
    await bumpCommit(command.sessionId);
    appendCommandEvent({
      sessionId: command.sessionId,
      commandId: command.id,
      type: 'code_change',
      payload: { commitIncremented: true }
    });
  }

  completeCommand(command.sessionId, command.id, { ok: true });
  appendCommandEvent({
    sessionId: command.sessionId,
    commandId: command.id,
    type: 'step_complete',
    payload: { step: 'process_command' }
  });
}

async function processCommentCommand(command: Command) {
  const session = await getSession(command.sessionId);
  if (!session) throw new Error(`session not found: ${command.sessionId}`);

  const commentBundle = command.commentId
    ? getComment(command.sessionId, command.commentId)
    : null;
  const designerMessage =
    commentBundle?.messages
      .filter((item) => item.role === 'designer')
      .slice(-1)[0]?.content || '요청 내용 없음';

  let result: { reply: string; diff: string };

  if (command.type === 'undo') {
    result = await executeUndo(session.worktreePath);
  } else {
    const elementContext = commentBundle
      ? buildElementContext(
          commentBundle.comment.element as unknown as Record<string, unknown>,
          commentBundle.comment.metadata as unknown as Record<string, unknown>
        )
      : '';

    appendCommandEvent({
      sessionId: command.sessionId,
      commandId: command.id,
      type: 'step_start',
      payload: { step: 'claude_edit', message: designerMessage.slice(0, 200) }
    });

    result = await executeClaudeEdit(
      session.worktreePath,
      designerMessage,
      elementContext
    );

    appendCommandEvent({
      sessionId: command.sessionId,
      commandId: command.id,
      type: 'step_complete',
      payload: { step: 'claude_edit', diff: result.diff.slice(0, 500) }
    });
  }

  if (command.commentId) {
    addCommentMessage({
      sessionId: command.sessionId,
      commentId: command.commentId,
      role: 'ai',
      content: result.reply,
      codeChanges: [{ path: 'workspace', diff: result.diff }]
    });

    setCommentStatus(command.sessionId, command.commentId, 'pending_review');
    appendCommandEvent({
      sessionId: command.sessionId,
      commandId: command.id,
      type: 'comment_update',
      payload: { commentId: command.commentId, status: 'pending_review' }
    });

    const latestThread = getComment(command.sessionId, command.commentId);
    const autoResolve = await checkAutoResolve({
      type: command.type,
      messages: latestThread?.messages || [],
      diff: result.diff
    });
    appendCommandEvent({
      sessionId: command.sessionId,
      commandId: command.id,
      type: 'auto_resolve',
      payload: {
        resolved: autoResolve.resolved,
        reason: autoResolve.reason,
        raw: autoResolve.raw
      }
    });

    if (autoResolve.resolved) {
      const resolved = setCommentStatus(
        command.sessionId,
        command.commentId,
        'resolved'
      );
      appendCommandEvent({
        sessionId: command.sessionId,
        commandId: command.id,
        type: 'comment_update',
        payload: { commentId: command.commentId, status: 'resolved' }
      });
      if (resolved?.agentationAnnotationId) {
        await resolveAnnotation(command.sessionId, resolved.agentationAnnotationId);
      }
    } else {
      setCommentStatus(command.sessionId, command.commentId, 'open');
      addCommentMessage({
        sessionId: command.sessionId,
        commentId: command.commentId,
        role: 'ai',
        content: `요청 반영 여부를 디자이너가 한 번 더 확인해주세요. 사유: ${autoResolve.reason}`
      });
    }
  }
}

async function tick() {
  const sessionIds = new Set<string>();
  for (const command of listCommandsForAllSessions()) {
    sessionIds.add(command.sessionId);
  }

  for (const sessionId of sessionIds) {
    const next = takeNextQueuedCommand(sessionId);
    if (!next) continue;

    try {
      await processCommand(next);
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : 'worker processing failed';
      failCommand(sessionId, next.id, reason, false);
      appendCommandEvent({
        sessionId,
        commandId: next.id,
        type: 'error',
        payload: { reason }
      });
    }
  }

  const stuck = findStuckCommands(COMMAND_TIMEOUT_MS);
  for (const command of stuck) {
    failCommand(command.sessionId, command.id, 'command timed out', true);
    if (command.commentId) {
      addCommentMessage({
        sessionId: command.sessionId,
        commentId: command.commentId,
        role: 'ai',
        content: '처리 시간이 초과되어 요청이 중단되었습니다. 다시 시도해주세요.'
      });
      setCommentStatus(command.sessionId, command.commentId, 'open');
    }
    appendCommandEvent({
      sessionId: command.sessionId,
      commandId: command.id,
      type: 'error',
      payload: { reason: 'timeout' }
    });
  }
}

function listCommandsForAllSessions() {
  const sessions = new Set<string>();
  const output: Command[] = [];

  for (const item of globalThis.__dpKnownSessionIds || []) sessions.add(item);

  for (const sessionId of sessions) {
    output.push(...listCommands(sessionId));
  }

  return output;
}

declare global {
  // eslint-disable-next-line no-var
  var __dpKnownSessionIds: string[] | undefined;
}

export function registerSessionForWorker(sessionId: string) {
  if (!globalThis.__dpKnownSessionIds) globalThis.__dpKnownSessionIds = [];
  if (!globalThis.__dpKnownSessionIds.includes(sessionId)) {
    globalThis.__dpKnownSessionIds.push(sessionId);
  }
}

export function startCommandWorker() {
  if (started) return;
  started = true;

  const pollMs = Number(
    process.env.COMMAND_QUEUE_POLL_INTERVAL_MS || DEFAULT_POLL_MS
  );
  setInterval(() => {
    void tick();
  }, pollMs);
}
