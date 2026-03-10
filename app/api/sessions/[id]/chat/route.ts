import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session-store';
import { ensureBackgroundRuntimes } from '@/lib/runtime';
import { createChatComment, enqueueCommand } from '@/lib/comment-store';
import { registerSessionForWorker } from '@/lib/command-worker';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  ensureBackgroundRuntimes();

  const { id } = await context.params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as { prompt?: string };
  const prompt = body.prompt?.trim() || '디자인 요청을 반영해주세요.';

  const comment = createChatComment(id, prompt);
  const command = enqueueCommand({
    sessionId: id,
    commentId: comment.id,
    type: 'chat_message',
    payload: { prompt }
  });
  registerSessionForWorker(id);

  return NextResponse.json({
    ok: true,
    comment,
    command
  });
}
