import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session-store';
import { ensureBackgroundRuntimes } from '@/lib/runtime';
import { enqueueCommand } from '@/lib/comment-store';
import { registerSessionForWorker } from '@/lib/command-worker';

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  ensureBackgroundRuntimes();

  const { id } = await context.params;
  if (!await getSession(id)) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  const command = enqueueCommand({
    sessionId: id,
    type: 'undo',
    payload: { strategy: 'git revert HEAD --no-edit' }
  });
  registerSessionForWorker(id);

  return NextResponse.json({ ok: true, command }, { status: 202 });
}
