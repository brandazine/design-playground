import { NextResponse } from 'next/server';
import { getSession, removeSession } from '@/lib/session-store';
import { ensureBackgroundRuntimes } from '@/lib/runtime';

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  ensureBackgroundRuntimes();
  const { id } = await context.params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(session);
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  ensureBackgroundRuntimes();
  const { id } = await context.params;
  const ok = await removeSession(id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
