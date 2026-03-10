import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session-store';
import { ensureBackgroundRuntimes } from '@/lib/runtime';
import { enqueueCommand, listCommands, type CommandType } from '@/lib/comment-store';
import { registerSessionForWorker } from '@/lib/command-worker';

const commandTypes: CommandType[] = ['annotation_batch', 'chat_reply', 'chat_message', 'undo'];

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  ensureBackgroundRuntimes();

  const { id } = await context.params;
  if (!await getSession(id)) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  return NextResponse.json({ items: listCommands(id) });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  ensureBackgroundRuntimes();

  const { id } = await context.params;
  if (!await getSession(id)) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as {
    type?: CommandType;
    payload?: Record<string, unknown>;
    commentId?: string | null;
  };

  if (!body.type || !commandTypes.includes(body.type)) {
    return NextResponse.json({ error: 'valid command type is required' }, { status: 400 });
  }

  const command = enqueueCommand({
    sessionId: id,
    commentId: body.commentId || null,
    type: body.type,
    payload: body.payload || {}
  });

  registerSessionForWorker(id);

  return NextResponse.json({ ok: true, item: command }, { status: 202 });
}
