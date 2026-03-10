import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session-store';
import { ensureBackgroundRuntimes } from '@/lib/runtime';
import { addCommentMessage, enqueueCommand, setCommentStatus } from '@/lib/comment-store';
import { registerSessionForWorker } from '@/lib/command-worker';

export async function POST(request: Request, context: { params: Promise<{ id: string; commentId: string }> }) {
  ensureBackgroundRuntimes();

  const { id, commentId } = await context.params;
  if (!await getSession(id)) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as { message?: string };
  const message = body.message?.trim();
  if (!message) {
    return NextResponse.json({ error: 'message is required' }, { status: 400 });
  }

  const created = addCommentMessage({
    sessionId: id,
    commentId,
    role: 'designer',
    content: message
  });
  if (!created) return NextResponse.json({ error: 'comment not found' }, { status: 404 });

  setCommentStatus(id, commentId, 'open');

  const command = enqueueCommand({
    sessionId: id,
    commentId,
    type: 'chat_reply',
    payload: { message }
  });
  registerSessionForWorker(id);

  return NextResponse.json({ ok: true, message: created, command });
}
