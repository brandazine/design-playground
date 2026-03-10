import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session-store';
import { ensureBackgroundRuntimes } from '@/lib/runtime';
import { addCommentMessage, setCommentStatus } from '@/lib/comment-store';
import { resolveAgentationAnnotation } from '@/lib/agentation-store';

export async function POST(request: Request, context: { params: Promise<{ id: string; commentId: string }> }) {
  ensureBackgroundRuntimes();

  const { id, commentId } = await context.params;
  if (!await getSession(id)) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as { summary?: string };
  const summary = body.summary?.trim();

  const updated = setCommentStatus(id, commentId, 'resolved');
  if (!updated) return NextResponse.json({ error: 'comment not found' }, { status: 404 });

  if (updated.agentationAnnotationId) {
    resolveAgentationAnnotation(id, updated.agentationAnnotationId);
  }

  if (summary) {
    addCommentMessage({
      sessionId: id,
      commentId,
      role: 'ai',
      content: `resolved: ${summary}`
    });
  }

  return NextResponse.json({ ok: true, item: updated });
}
