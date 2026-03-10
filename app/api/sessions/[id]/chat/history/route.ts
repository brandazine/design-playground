import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session-store';
import { ensureBackgroundRuntimes } from '@/lib/runtime';
import { getComment, listComments } from '@/lib/comment-store';

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  ensureBackgroundRuntimes();

  const { id } = await context.params;
  if (!await getSession(id)) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  const comments = listComments(id).filter((item) => item.element.selector === 'chat');
  const items = comments.flatMap((comment) => getComment(id, comment.id)?.messages || []);

  return NextResponse.json({ items });
}
