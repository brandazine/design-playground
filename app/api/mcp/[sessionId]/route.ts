import { NextResponse } from 'next/server';
import { getSession, type SessionItem } from '@/lib/session-store';
import { addCommentMessage, getComment, setCommentStatus } from '@/lib/comment-store';
import { resolveAgentationAnnotation } from '@/lib/agentation-store';

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

type ToolCallParams = {
  name?: string;
  arguments?: Record<string, unknown>;
};

const protocolVersion = '2024-11-05';

const tools = [
  {
    name: 'comment_reply',
    description: '코멘트에 AI reply 추가',
    inputSchema: {
      type: 'object',
      properties: {
        commentId: { type: 'string', description: 'Comment UUID' },
        message: { type: 'string', description: 'Reply 내용' }
      },
      required: ['commentId', 'message']
    }
  },
  {
    name: 'comment_resolve',
    description: '코멘트를 resolve 상태로 변경',
    inputSchema: {
      type: 'object',
      properties: {
        commentId: { type: 'string', description: 'Comment UUID' },
        summary: { type: 'string', description: '해결 요약' }
      },
      required: ['commentId']
    }
  },
  {
    name: 'session_info',
    description: '현재 세션 정보 반환 (브랜치, 상태, 프리뷰 URL 등)',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'preview_url',
    description: '프리뷰 URL 반환',
    inputSchema: { type: 'object', properties: {} }
  }
] as const;

function ok(id: JsonRpcRequest['id'], result: unknown) {
  return NextResponse.json({ jsonrpc: '2.0', id: id ?? null, result });
}

function fail(id: JsonRpcRequest['id'], code: number, message: string) {
  return NextResponse.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, { status: 400 });
}

function toolResult(id: JsonRpcRequest['id'], payload: unknown, isError = false) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return ok(id, {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {})
  });
}

function getPreviewUrl(sessionId: string, requestUrl: string, previewPath: string) {
  return new URL(previewPath, requestUrl.startsWith('http') ? requestUrl : `http://localhost${previewPath}`).toString();
}

function callTool(
  requestId: JsonRpcRequest['id'],
  requestUrl: string,
  session: SessionItem,
  params: ToolCallParams
) {
  const name = String(params.name || '').trim();
  const args = params.arguments || {};

  if (name === 'session_info') {
    return toolResult(requestId, {
      sessionId: session.id,
      repositoryId: session.repositoryId,
      repoFullName: session.repoFullName,
      baseBranch: session.baseBranch,
      branch: session.branch,
      status: session.status,
      previewUrl: getPreviewUrl(session.id, requestUrl, session.previewPath),
      devServerPort: session.devServerPort,
      worktreePath: session.worktreePath
    });
  }

  if (name === 'preview_url') {
    return toolResult(requestId, { url: getPreviewUrl(session.id, requestUrl, session.previewPath) });
  }

  if (name === 'comment_reply') {
    const commentId = String(args.commentId || '').trim();
    const message = String(args.message || '').trim();
    if (!commentId || !message) {
      return toolResult(requestId, 'commentId and message are required', true);
    }

    const comment = getComment(session.id, commentId);
    if (!comment) return toolResult(requestId, `Comment not found: ${commentId}`, true);

    const created = addCommentMessage({ sessionId: session.id, commentId, role: 'ai', content: message });
    return toolResult(requestId, { ok: true, commentId, message: created });
  }

  if (name === 'comment_resolve') {
    const commentId = String(args.commentId || '').trim();
    const summary = String(args.summary || '').trim();
    if (!commentId) return toolResult(requestId, 'commentId is required', true);

    const updated = setCommentStatus(session.id, commentId, 'resolved');
    if (!updated) return toolResult(requestId, `Comment not found: ${commentId}`, true);

    if (updated.agentationAnnotationId) {
      resolveAgentationAnnotation(session.id, updated.agentationAnnotationId);
    }

    if (summary) {
      addCommentMessage({
        sessionId: session.id,
        commentId,
        role: 'ai',
        content: `resolved: ${summary}`
      });
    }

    return toolResult(requestId, { ok: true, commentId, summary });
  }

  return toolResult(requestId, `Tool not found: ${name}`, true);
}

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await context.params;
  const session = await getSession(sessionId);
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as JsonRpcRequest;
  const method = body.method;
  const params = body.params || {};

  if (method === 'initialize') {
    return ok(body.id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'project-tools', version: '1.0.0' }
    });
  }

  if (method === 'tools/list') {
    return ok(body.id, { tools });
  }

  if (method === 'tools/call') {
    return callTool(body.id, request.url, session, params as ToolCallParams);
  }

  // Backward-compatible direct method calls.
  if (method === 'session_info' || method === 'preview_url' || method === 'comment_reply' || method === 'comment_resolve') {
    return callTool(body.id, request.url, session, { name: method, arguments: params });
  }

  return fail(body.id, -32601, `method not found: ${String(method || '')}`);
}
