import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session-store';
import { ensureBackgroundRuntimes } from '@/lib/runtime';
import { addCommentMessage, setCommentStatus } from '@/lib/comment-store';
import { dismissAgentationAnnotation } from '@/lib/agentation-store';

export async function POST(request: Request, context: { params: Promise<{ id: string; commentId: string }> }) {
  ensureBackgroundRuntimes();

  const { id, commentId } = await context.params;
  if (!await getSession(id)) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as { reason?: string };
  const reason = body.reason?.trim() || 'dismissed by designer';

  const updated = setCommentStatus(id, commentId, 'dismissed');
  if (!updated) return NextResponse.json({ error: 'comment not found' }, { status: 404 });

  if (updated.agentationAnnotationId) {
    dismissAgentationAnnotation(id, updated.agentationAnnotationId);
  }

  addCommentMessage({
    sessionId: id,
    commentId,
    role: 'designer',
    content: `dismissed: ${reason}`
  });

  return NextResponse.json({ ok: true, item: updated });
}
