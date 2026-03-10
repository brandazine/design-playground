import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session-store';
import { resolveAgentationAnnotation } from '@/lib/agentation-store';

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await context.params;
  if (!await getSession(sessionId)) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as { annotationId?: string };
  const annotationId = body.annotationId?.trim();
  if (!annotationId) return NextResponse.json({ error: 'annotationId is required' }, { status: 400 });

  const item = resolveAgentationAnnotation(sessionId, annotationId);
  if (!item) return NextResponse.json({ error: 'annotation not found' }, { status: 404 });

  return NextResponse.json({ ok: true, item });
}
