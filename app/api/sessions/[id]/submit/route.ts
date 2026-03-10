import { NextResponse } from 'next/server';
import { submitSession } from '@/lib/session-store';

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await submitSession(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(session);
}
