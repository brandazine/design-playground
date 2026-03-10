import { NextResponse } from 'next/server';
import { getSession, getSessionCreation } from '@/lib/session-store';
import { ensureBackgroundRuntimes } from '@/lib/runtime';
import { registerSessionForWorker } from '@/lib/command-worker';

export const dynamic = 'force-dynamic';

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  ensureBackgroundRuntimes();
  const { id } = await context.params;
  const creation = await getSessionCreation(id);

  if (!creation) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  if (creation.sessionId) registerSessionForWorker(creation.sessionId);

  return NextResponse.json({
    ...creation,
    session: creation.sessionId ? await getSession(creation.sessionId) : null
  });
}
