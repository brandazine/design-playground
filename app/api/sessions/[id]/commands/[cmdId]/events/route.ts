import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session-store';
import { ensureBackgroundRuntimes } from '@/lib/runtime';
import { getCommand, listCommandEvents } from '@/lib/comment-store';

export async function GET(request: Request, context: { params: Promise<{ id: string; cmdId: string }> }) {
  ensureBackgroundRuntimes();

  const { id, cmdId } = await context.params;
  if (!await getSession(id)) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  if (!getCommand(id, cmdId)) return NextResponse.json({ error: 'command not found' }, { status: 404 });

  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor') || undefined;
  const limit = Number(url.searchParams.get('limit') || '100');

  return NextResponse.json(listCommandEvents(cmdId, cursor, limit));
}
