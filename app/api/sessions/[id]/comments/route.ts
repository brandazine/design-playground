import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session-store';
import { ensureBackgroundRuntimes } from '@/lib/runtime';
import { listComments, type CommentStatus } from '@/lib/comment-store';

const allowedStatuses: CommentStatus[] = ['open', 'processing', 'pending_review', 'resolved', 'dismissed'];

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  ensureBackgroundRuntimes();

  const { id } = await context.params;
  if (!await getSession(id)) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  const url = new URL(request.url);
  const statusParam = url.searchParams.get('status');
  const status =
    statusParam && allowedStatuses.includes(statusParam as CommentStatus)
      ? (statusParam as CommentStatus)
      : undefined;

  return NextResponse.json({ items: listComments(id, status) });
}
