import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session-store';
import { ensureBackgroundRuntimes } from '@/lib/runtime';
import { getComment } from '@/lib/comment-store';

export async function GET(_: Request, context: { params: Promise<{ id: string; commentId: string }> }) {
  ensureBackgroundRuntimes();

  const { id, commentId } = await context.params;
  if (!await getSession(id)) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  const item = getComment(id, commentId);
  if (!item) return NextResponse.json({ error: 'comment not found' }, { status: 404 });

  return NextResponse.json(item);
}
