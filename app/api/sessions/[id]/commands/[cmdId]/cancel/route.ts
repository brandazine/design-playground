import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session-store';
import { ensureBackgroundRuntimes } from '@/lib/runtime';
import { appendCommandEvent, cancelCommand } from '@/lib/comment-store';

export async function POST(_: Request, context: { params: Promise<{ id: string; cmdId: string }> }) {
  ensureBackgroundRuntimes();

  const { id, cmdId } = await context.params;
  if (!await getSession(id)) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  const command = cancelCommand(id, cmdId);
  if (!command) return NextResponse.json({ error: 'command not found' }, { status: 404 });

  appendCommandEvent({
    sessionId: id,
    commandId: cmdId,
    type: 'error',
    payload: { reason: 'cancelled by user' }
  });

  return NextResponse.json({ ok: true, item: command });
}
