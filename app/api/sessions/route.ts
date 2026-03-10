import { NextResponse } from 'next/server';
import { enrichSessionWithGit, listSessions, startSessionCreation } from '@/lib/session-store';
import { ensureBackgroundRuntimes } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

export async function GET() {
  ensureBackgroundRuntimes();
  const raw = await listSessions();
  const items = await Promise.all(raw.map((s) => enrichSessionWithGit(s)));
  return NextResponse.json({ items });
}

export async function POST(request: Request) {
  ensureBackgroundRuntimes();
  const body = (await request.json().catch(() => ({}))) as {
    repositoryId?: string;
    baseBranch?: string;
  };

  const repositoryId = body.repositoryId?.trim();
  if (!repositoryId) {
    return NextResponse.json({ error: 'repositoryId is required' }, { status: 400 });
  }

  const baseBranch = body.baseBranch?.trim() || 'main';

  try {
    const creation = await startSessionCreation({ repositoryId, baseBranch });
    return NextResponse.json(creation, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'failed to start session creation' },
      { status: 400 }
    );
  }
}
