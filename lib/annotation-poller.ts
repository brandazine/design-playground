import {
  appendCommandEvent,
  createCommentFromAnnotation,
  enqueueCommand,
  findCommentByAnnotation,
  type AnnotationInput
} from '@/lib/comment-store';
import {
  acknowledgeAgentationAnnotation,
  getPendingAgentationAnnotations,
  resolveAgentationAnnotation
} from '@/lib/agentation-store';
import { listSessions } from '@/lib/session-store';
import { registerSessionForWorker } from '@/lib/command-worker';

type PendingAnnotation = AnnotationInput;

type AgentationClient = {
  getPending(sessionId: string): Promise<PendingAnnotation[]>;
  acknowledge(sessionId: string, annotationId: string): Promise<void>;
  resolve(sessionId: string, annotationId: string): Promise<void>;
};

const pendingBySession = new Map<string, Array<{ annotation: PendingAnnotation; receivedAt: number }>>();
const acknowledgedIds = new Set<string>();

let started = false;

class FileAgentationClient implements AgentationClient {
  async getPending(sessionId: string): Promise<PendingAnnotation[]> {
    return getPendingAgentationAnnotations(sessionId).map((item) => ({
      annotationId: item.id,
      message: item.message,
      element: item.element,
      metadata: item.metadata
    }));
  }

  async acknowledge(sessionId: string, annotationId: string): Promise<void> {
    acknowledgeAgentationAnnotation(sessionId, annotationId);
    acknowledgedIds.add(annotationId);
  }

  async resolve(sessionId: string, annotationId: string): Promise<void> {
    resolveAgentationAnnotation(sessionId, annotationId);
  }
}

const client: AgentationClient = new FileAgentationClient();

function now() {
  return Date.now();
}

function toCommandPayload(batch: Array<{ annotation: PendingAnnotation; receivedAt: number }>) {
  return {
    annotationIds: batch.map((item) => item.annotation.annotationId),
    commentIds: [] as string[],
    size: batch.length,
    receivedAt: batch.map((item) => item.receivedAt)
  };
}

async function collectPending(sessionId: string) {
  const incoming = await client.getPending(sessionId);
  if (incoming.length === 0) return;

  const queue = pendingBySession.get(sessionId) || [];
  for (const annotation of incoming) {
    if (acknowledgedIds.has(annotation.annotationId)) continue;
    if (findCommentByAnnotation(sessionId, annotation.annotationId)) continue;

    createCommentFromAnnotation(sessionId, annotation);
    await client.acknowledge(sessionId, annotation.annotationId);
    queue.push({ annotation, receivedAt: now() });
  }
  pendingBySession.set(sessionId, queue);
}

function flushBatch(sessionId: string, batchWindowMs: number) {
  const queue = pendingBySession.get(sessionId);
  if (!queue || queue.length === 0) return;

  const first = queue[0];
  if (!first) return;

  if (now() - first.receivedAt < batchWindowMs) return;

  const payload = toCommandPayload(queue);
  const commentIds: string[] = [];
  for (const item of queue) {
    const comment = findCommentByAnnotation(sessionId, item.annotation.annotationId);
    if (comment) commentIds.push(comment.id);
  }
  payload.commentIds = commentIds;
  const command = enqueueCommand({
    sessionId,
    type: 'annotation_batch',
    payload
  });

  registerSessionForWorker(sessionId);
  pendingBySession.set(sessionId, []);

  if (command.id) {
    appendCommandEvent({
      sessionId,
      commandId: command.id,
      type: 'step_start',
      payload: { step: 'annotation_batch_enqueued', count: queue.length }
    });
  }
}

async function tick(pollMs: number, batchWindowMs: number) {
  const sessions = (await listSessions()).filter((session) => session.status === 'active');
  if (sessions.length === 0) return;

  await Promise.all(
    sessions.map(async (session) => {
      registerSessionForWorker(session.id);
      await collectPending(session.id);
      flushBatch(session.id, batchWindowMs);
    })
  );

  await new Promise((resolve) => setTimeout(resolve, Math.max(1, pollMs / 5)));
}

export function startAnnotationPoller() {
  if (started) return;
  started = true;

  const pollMs = Number(process.env.ANNOTATION_POLL_INTERVAL_MS || '500');
  const batchWindowMs = Number(process.env.ANNOTATION_BATCH_WINDOW_MS || '3000');

  setInterval(() => {
    void tick(pollMs, batchWindowMs);
  }, pollMs);
}

export async function resolveAnnotation(sessionId: string, annotationId: string) {
  await client.resolve(sessionId, annotationId);
}
