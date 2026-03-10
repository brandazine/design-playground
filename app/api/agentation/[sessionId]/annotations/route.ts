import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session-store';
import {
  createAgentationAnnotation,
  getPendingAgentationAnnotations,
  listAgentationAnnotations
} from '@/lib/agentation-store';
import { ensureBackgroundRuntimes } from '@/lib/runtime';

export async function GET(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await context.params;
  if (!await getSession(sessionId)) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  const url = new URL(request.url);
  const onlyPending = url.searchParams.get('pending') === 'true';
  const items = onlyPending ? getPendingAgentationAnnotations(sessionId) : listAgentationAnnotations(sessionId);
  return NextResponse.json({ items });
}

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  ensureBackgroundRuntimes();
  const { sessionId } = await context.params;
  if (!await getSession(sessionId)) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as {
    message?: string;
    element?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  };

  const message = body.message?.trim();
  if (!message) return NextResponse.json({ error: 'message is required' }, { status: 400 });

  const item = createAgentationAnnotation({
    sessionId,
    message,
    element: body.element,
    metadata: body.metadata
  });

  return NextResponse.json({ ok: true, item }, { status: 201 });
}
