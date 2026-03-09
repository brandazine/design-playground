'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { GitPullRequestArrow, RefreshCw, RotateCcw, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

type Repository = {
  id: string;
  name: string;
  fullName: string;
  defaultBranch: string;
};

type Session = {
  id: string;
  status: string;
  repositoryId: string;
  repoFullName: string;
  baseBranch: string;
  branch: string;
  worktreePath: string;
  devServerPort: number;
  previewPath: string;
  commitCount: number;
  prUrl: string | null;
};

type SessionCreation = {
  id: string;
  status: 'creating' | 'active' | 'error';
  currentStep: string;
  steps: string[];
  sessionId: string | null;
  error: string | null;
  session: Session | null;
};

type CommentStatus = 'open' | 'processing' | 'pending_review' | 'resolved' | 'dismissed';

type Comment = {
  id: string;
  status: CommentStatus;
  category: string;
  element: {
    selector: string;
    tagName: string;
    className?: string;
    componentName?: string;
    componentPath?: string;
  };
  createdAt: string;
};

type CommentMessage = {
  id: string;
  role: 'designer' | 'ai';
  content: string;
  codeChanges?: Array<{ path: string; diff: string }>;
  createdAt: string;
};

type InspectorData = {
  selector: string;
  tagName: string;
  className?: string;
  componentName?: string;
  componentPath?: string;
  computedStyles?: Record<string, string>;
  boxModel?: {
    content: { width: number; height: number };
    padding: { top: number; right: number; bottom: number; left: number };
    margin: { top: number; right: number; bottom: number; left: number };
  };
  viewport?: { width: number; height: number };
};

type Annotation = {
  id: string;
  message: string;
  status: 'pending' | 'acknowledged' | 'resolved' | 'dismissed';
};

function normalizeCreation(data: unknown): SessionCreation | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;

  if (typeof obj.id !== 'string') return null;
  if (obj.status !== 'creating' && obj.status !== 'active' && obj.status !== 'error') return null;

  return {
    id: obj.id,
    status: obj.status,
    currentStep: typeof obj.currentStep === 'string' ? obj.currentStep : '',
    steps: Array.isArray(obj.steps) ? obj.steps.filter((v): v is string => typeof v === 'string') : [],
    sessionId: typeof obj.sessionId === 'string' ? obj.sessionId : null,
    error: typeof obj.error === 'string' ? obj.error : null,
    session: (obj.session as Session | null) ?? null
  };
}

function statusTone(status: CommentStatus) {
  if (status === 'resolved') return 'text-sky-700';
  if (status === 'processing') return 'text-indigo-600';
  if (status === 'dismissed') return 'text-slate-400';
  if (status === 'pending_review') return 'text-cyan-700';
  return 'text-blue-700';
}

export function Workbench() {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [repositoryId, setRepositoryId] = useState('workspace');
  const [baseBranch, setBaseBranch] = useState('main');
  const [prompt, setPrompt] = useState('버튼 텍스트를 좀 더 굵게 바꿔줘');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [branchQuery, setBranchQuery] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState<SessionCreation | null>(null);
  const [tab, setTab] = useState<'comments' | 'design'>('comments');
  const [statusFilter, setStatusFilter] = useState<'all' | CommentStatus>('all');
  const [comments, setComments] = useState<Comment[]>([]);
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<CommentMessage[]>([]);
  const [replyText, setReplyText] = useState('');
  const [inspector, setInspector] = useState<InspectorData | null>(null);
  const [annotationText, setAnnotationText] = useState('이 요소를 조금 더 정리해주세요.');
  const [annotations, setAnnotations] = useState<Annotation[]>([]);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const selectedRepository = useMemo(
    () => repositories.find((repo) => repo.id === repositoryId) ?? null,
    [repositories, repositoryId]
  );

  const selectedComment = useMemo(
    () => comments.find((item) => item.id === selectedCommentId) ?? null,
    [comments, selectedCommentId]
  );
  const selectedDiffs = useMemo(
    () => messages.flatMap((message) => message.codeChanges || []),
    [messages]
  );

  useEffect(() => {
    fetch('/api/repositories')
      .then((res) => res.json())
      .then((data) => {
        const items = (data.items || []) as Repository[];
        setRepositories(items);
        const preferred = items.find((repo) => repo.id === 'workspace') ?? items[0];
        if (preferred) {
          setRepositoryId(preferred.id);
          setBaseBranch(preferred.defaultBranch);
        }
      })
      .catch(() => {});

    refreshSessions();
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const payload = event.data as { type?: string; data?: InspectorData };
      if (!payload || payload.type !== 'element-hover' || !payload.data) return;
      setInspector(payload.data);
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (!session) return;

    let stopped = false;

    const poll = async () => {
      if (stopped) return;
      const statusParam = statusFilter === 'all' ? '' : `?status=${statusFilter}`;

      const [commentsRes, annotationsRes] = await Promise.all([
        fetch(`/api/sessions/${session.id}/comments${statusParam}`, { cache: 'no-store' }),
        fetch(`/api/agentation/${session.id}/annotations`, { cache: 'no-store' })
      ]).catch(() => [null, null] as const);

      if (commentsRes && commentsRes.ok) {
        const data = await commentsRes.json();
        const items = (data.items || []) as Comment[];
        setComments(items);
        if (!selectedCommentId && items[0]) setSelectedCommentId(items[0].id);
      }

      if (annotationsRes && annotationsRes.ok) {
        const data = await annotationsRes.json();
        setAnnotations((data.items || []) as Annotation[]);
      }
    };

    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 1000);

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [session, selectedCommentId, statusFilter]);

  useEffect(() => {
    if (!session || !selectedCommentId) {
      setMessages([]);
      return;
    }

    fetch(`/api/sessions/${session.id}/comments/${selectedCommentId}`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => setMessages((data.messages || []) as CommentMessage[]))
      .catch(() => setMessages([]));
  }, [session, selectedCommentId, comments]);

  async function refreshSessions() {
    try {
      const res = await fetch('/api/sessions');
      const data = await res.json();
      const items = (data.items || []) as Session[];
      setSessions(items);
      if (!session && items.length > 0) setSession(items[0]);
    } catch {}
  }

  async function deleteSession(id: string) {
    await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    if (session?.id === id) setSession(null);
    await refreshSessions();
  }

  async function loadBranches() {
    if (!repositoryId) return;
    setLoading(true);
    const url = new URL(`/api/repositories/${repositoryId}/branches`, window.location.origin);
    if (branchQuery.trim()) url.searchParams.set('q', branchQuery.trim());
    const res = await fetch(url.toString());
    const data = await res.json();
    setBranches(data.items || []);
    setLoading(false);
  }

  async function pollCreation(creationId: string) {
    for (;;) {
      const res = await fetch(`/api/sessions/creation/${creationId}`, { cache: 'no-store' });
      const raw = await res.json().catch(() => null);
      const data = normalizeCreation(raw);

      if (!res.ok || !data) {
        setCreating({
          id: creationId,
          status: 'error',
          currentStep: '세션 생성 상태 조회 실패',
          steps: [`조회 실패(HTTP ${res.status})`, '세션 생성 상태 조회 실패'],
          sessionId: null,
          error: '세션 생성 상태를 읽을 수 없습니다.',
          session: null
        });
        return;
      }

      setCreating(data);

      if (data.status === 'active') {
        if (data.session) setSession(data.session);
        return;
      }

      if (data.status === 'error') return;
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }

  async function createSession() {
    if (!repositoryId) return;

    // Check if a session already exists for this repo+branch
    const existing = sessions.find(
      (s) => s.repositoryId === repositoryId && s.baseBranch === baseBranch && s.status === 'active'
    );
    if (existing) {
      setSession(existing);
      return;
    }

    setLoading(true);
    setCreating(null);

    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repositoryId, baseBranch })
    });
    const data = await res.json();

    if (!res.ok) {
      alert(data.error || 'failed to create session');
      setLoading(false);
      return;
    }

    await pollCreation(data.id);
    await refreshSessions();
    setLoading(false);
  }

  async function sendPrompt() {
    if (!session || !prompt.trim()) return;
    setLoading(true);
    await fetch(`/api/sessions/${session.id}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });
    setLoading(false);
  }

  async function submitPr() {
    if (!session) return;
    setLoading(true);
    const updated = await fetch(`/api/sessions/${session.id}/submit`, { method: 'POST' }).then((r) => r.json());
    setSession(updated);
    setLoading(false);
  }

  async function enqueueUndo() {
    if (!session) return;
    setLoading(true);
    await fetch(`/api/sessions/${session.id}/undo`, { method: 'POST' });
    setLoading(false);
  }

  async function replyToComment() {
    if (!session || !selectedCommentId || !replyText.trim()) return;
    const text = replyText.trim();
    setReplyText('');
    await fetch(`/api/sessions/${session.id}/comments/${selectedCommentId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text })
    });
  }

  async function resolveSelectedComment() {
    if (!session || !selectedCommentId) return;
    await fetch(`/api/sessions/${session.id}/comments/${selectedCommentId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: 'designer confirmed' })
    });
  }

  async function dismissSelectedComment() {
    if (!session || !selectedCommentId) return;
    await fetch(`/api/sessions/${session.id}/comments/${selectedCommentId}/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'designer dismissed' })
    });
  }

  async function createAnnotation() {
    if (!session || !annotationText.trim()) return;

    await fetch(`/api/agentation/${session.id}/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: annotationText,
        element: inspector
          ? {
              selector: inspector.selector,
              tagName: inspector.tagName,
              className: inspector.className,
              componentName: inspector.componentName,
              componentPath: inspector.componentPath
            }
          : undefined,
        metadata: inspector
          ? {
              viewport: inspector.viewport,
              computedStyles: inspector.computedStyles,
              boxModel: inspector.boxModel,
              coordinates: { x: 0, y: 0 }
            }
          : undefined
      })
    });
  }

  function focusCommentTarget(comment: Comment) {
    if (!iframeRef.current) return;
    iframeRef.current.contentWindow?.postMessage({ type: 'highlight-selector', selector: comment.element.selector }, '*');
  }

  function queueInspectorAnnotation(label: string, value?: string) {
    if (!value || value === '-') return;
    setAnnotationText(`${label} 값(${value})을 스펙에 맞게 조정해주세요.`);
    setTab('design');
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[1900px] flex-col gap-5 p-4 lg:flex-row lg:p-7">
      <Card className="toss-panel min-h-[80vh] flex-1 border-0">
        <CardHeader className="pb-3">
          <CardTitle className="text-xl font-bold tracking-tight text-slate-900">Preview</CardTitle>
          <CardDescription className="text-slate-500">
            {session ? `localhost:${session.devServerPort}` : '세션 생성 후 프리뷰가 여기에 렌더링됩니다.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {session ? (
            <iframe
              ref={iframeRef}
              title="Session Preview"
              src={`http://localhost:${session.devServerPort}`}
              className="h-[70vh] w-full rounded-2xl border border-slate-200 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]"
            />
          ) : (
            <div className="h-[70vh] w-full rounded-2xl border border-slate-200 bg-white/70 p-6">
              <p className="text-sm text-slate-500">세션이 없습니다.</p>
            </div>
          )}

          <div className="flex gap-2">
            <Input
              value={annotationText}
              onChange={(e) => setAnnotationText(e.target.value)}
              placeholder="화면 annotation 요청"
              disabled={!session}
            />
            <Button
              variant="secondary"
              className="rounded-xl bg-blue-50 text-blue-700 hover:bg-blue-100"
              onClick={createAnnotation}
              disabled={!session || loading}
            >
              Annotation 생성
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="toss-panel w-full border-0 lg:sticky lg:top-6 lg:h-[calc(100vh-3rem)] lg:w-[520px] lg:shrink-0">
        <CardHeader className="space-y-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xl font-bold tracking-tight text-slate-900">Session Panel</CardTitle>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setTab('comments')}
                className={`toss-chip px-3 py-1 text-sm font-medium ${
                  tab === 'comments' ? 'toss-chip-active' : ''
                }`}
              >
                Comments
              </button>
              <button
                type="button"
                onClick={() => setTab('design')}
                className={`toss-chip px-3 py-1 text-sm font-medium ${
                  tab === 'design' ? 'toss-chip-active' : ''
                }`}
              >
                Design
              </button>
            </div>
          </div>

          <CardDescription className="text-slate-500">스펙 기반: 코멘트 스레드 + 인스펙터</CardDescription>

          <div>
            <p className="mb-2 text-xs text-muted-foreground">Repository</p>
            <select
              value={repositoryId}
              onChange={(e) => {
                const id = e.target.value;
                setRepositoryId(id);
                const found = repositories.find((repo) => repo.id === id);
                if (found) setBaseBranch(found.defaultBranch);
              }}
              className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm shadow-sm"
            >
              {repositories.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.name} ({repo.fullName})
                </option>
              ))}
            </select>
            {selectedRepository && (
              <p className="mt-1 text-xs text-slate-500">Allowed: {selectedRepository.fullName}</p>
            )}
          </div>

          <div className="flex gap-2">
            <Input value={branchQuery} onChange={(e) => setBranchQuery(e.target.value)} placeholder="브랜치 검색어" />
            <Button
              variant="outline"
              className="rounded-xl border-slate-200 bg-white hover:bg-slate-50"
              onClick={loadBranches}
              disabled={!repositoryId || loading}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>

          {branches.length > 0 && (
            <div className="max-h-32 overflow-y-auto rounded-xl border border-slate-200 bg-white">
              {branches.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => setBaseBranch(name)}
                  className="block w-full border-b border-slate-100 px-3 py-2 text-left text-sm hover:bg-slate-50 last:border-0"
                >
                  {name}
                </button>
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <Input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} placeholder="base branch" />
            <Button className="rounded-xl bg-blue-600 text-white hover:bg-blue-700" onClick={createSession} disabled={loading || !repositoryId}>
              {loading ? '생성 중...' : '세션 시작'}
            </Button>
          </div>

          {creating && (
            <div className="rounded-2xl border border-blue-100 bg-blue-50/70 p-3 text-sm">
              <p className="font-semibold text-blue-900">{creating.status}</p>
              <p className="mt-1 text-blue-700">{creating.currentStep}</p>
            </div>
          )}

          {sessions.length > 0 && (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-medium text-slate-700">Active Sessions ({sessions.length})</p>
                <Button variant="ghost" className="h-6 w-6 p-0" onClick={refreshSessions}>
                  <RefreshCw className="h-3 w-3" />
                </Button>
              </div>
              <div className="max-h-40 space-y-1 overflow-y-auto">
                {sessions.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSession(s)}
                    className={`flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left text-xs transition ${
                      session?.id === s.id
                        ? 'border-blue-300 bg-blue-50/70 shadow-sm'
                        : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-slate-800">{s.repoFullName}</p>
                      <p className="truncate text-[11px] text-slate-500">{s.baseBranch} &rarr; {s.branch} · :{s.devServerPort}</p>
                    </div>
                    <div className="ml-2 flex shrink-0 items-center gap-2">
                      <span className={`inline-block h-1.5 w-1.5 rounded-full ${s.status === 'active' ? 'bg-green-500' : 'bg-slate-300'}`} />
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); void deleteSession(s.id); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); void deleteSession(s.id); } }}
                        className="cursor-pointer text-[10px] text-slate-400 hover:text-red-500"
                        title="세션 삭제"
                      >
                        &times;
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </CardHeader>

        <CardContent className="space-y-3 overflow-y-auto">
          <div className="flex gap-2">
            <Input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="자유 수정 요청" />
            <Button className="rounded-xl bg-blue-600 text-white hover:bg-blue-700" onClick={sendPrompt} disabled={!session || loading}>
              <Send className="h-4 w-4" />
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" className="gap-2 rounded-xl border-slate-200 bg-white hover:bg-slate-50" onClick={submitPr} disabled={!session || loading}>
              <GitPullRequestArrow className="h-4 w-4" /> PR 제출
            </Button>
            <Button variant="outline" className="gap-2 rounded-xl border-slate-200 bg-white hover:bg-slate-50" onClick={enqueueUndo} disabled={!session || loading}>
              <RotateCcw className="h-4 w-4" /> Undo
            </Button>
          </div>

          {session && (
            <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3 text-xs text-slate-600">
              <p>branch: {session.branch}</p>
              <p>commitCount: {session.commitCount}</p>
              <p>pr: {session.prUrl ?? 'not submitted'}</p>
            </div>
          )}

          {tab === 'comments' && (
            <>
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Comment Threads</p>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as 'all' | CommentStatus)}
                  className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs"
                >
                  <option value="all">all</option>
                  <option value="open">open</option>
                  <option value="processing">processing</option>
                  <option value="pending_review">pending_review</option>
                  <option value="resolved">resolved</option>
                  <option value="dismissed">dismissed</option>
                </select>
              </div>

              <div className="space-y-2">
                {comments.map((comment) => (
                  <button
                    key={comment.id}
                    type="button"
                    onClick={() => {
                      setSelectedCommentId(comment.id);
                      focusCommentTarget(comment);
                    }}
                    className={`w-full rounded-xl border p-2 text-left text-xs transition ${
                      selectedCommentId === comment.id
                        ? 'border-blue-300 bg-blue-50/70 shadow-sm'
                        : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                  >
                    <p className="truncate font-medium">
                      {comment.element.componentName || comment.element.tagName} · {comment.element.selector}
                    </p>
                    <p className="truncate text-[11px] text-slate-500">
                      {comment.element.componentPath || comment.element.className || 'component path unavailable'}
                    </p>
                    <p className={statusTone(comment.status)}>{comment.status}</p>
                  </button>
                ))}
                {comments.length === 0 && <p className="text-xs text-slate-500">코멘트가 없습니다.</p>}
              </div>

              {selectedComment && (
                <div className="space-y-2 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
                  <p className="text-xs font-medium">
                    {selectedComment.element.componentName || selectedComment.element.tagName}
                    {selectedComment.element.componentPath ? ` · ${selectedComment.element.componentPath}` : ''}
                  </p>
                  <p className={`text-xs ${statusTone(selectedComment.status)}`}>{selectedComment.status}</p>
                  <div className="max-h-40 space-y-2 overflow-y-auto">
                    {messages.map((message) => (
                      <div key={message.id} className="rounded-xl border border-slate-200 p-2 text-xs">
                        <p className="font-semibold text-slate-700">{message.role}</p>
                        <p className="mt-1 whitespace-pre-wrap">{message.content}</p>
                        {message.codeChanges?.map((change) => (
                          <pre
                            key={`${message.id}-${change.path}`}
                            className="mt-2 overflow-x-auto rounded-lg bg-slate-950 p-2 text-[11px] text-slate-100"
                          >
                            [{change.path}]
                            {'\n'}
                            {change.diff}
                          </pre>
                        ))}
                      </div>
                    ))}
                  </div>
                  {selectedDiffs.length > 0 && (
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-2 text-[11px] text-slate-600">
                      <p className="font-semibold text-slate-800">Latest diff summary</p>
                      <p className="mt-1">{selectedDiffs[selectedDiffs.length - 1]?.path}</p>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="outline"
                      className="rounded-xl border-slate-200 bg-white hover:bg-slate-50"
                      onClick={resolveSelectedComment}
                    >
                      Resolve
                    </Button>
                    <Button
                      variant="outline"
                      className="rounded-xl border-slate-200 bg-white hover:bg-slate-50"
                      onClick={dismissSelectedComment}
                    >
                      Dismiss
                    </Button>
                  </div>
                  <div className="flex gap-2">
                    <Input value={replyText} onChange={(e) => setReplyText(e.target.value)} placeholder="reply" />
                    <Button onClick={replyToComment}>Reply</Button>
                  </div>
                </div>
              )}

              <div className="rounded-2xl border border-slate-200 bg-white p-3 text-xs">
                <p className="font-semibold text-slate-800">Agentation 상태</p>
                <div className="mt-2 space-y-1">
                  {annotations.slice(-6).map((item) => (
                    <p key={item.id}>
                      {item.status} · {item.message}
                    </p>
                  ))}
                </div>
              </div>
            </>
          )}

          {tab === 'design' && (
            <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-3 text-xs">
              <div>
                <p className="font-medium">Element</p>
                <p>{inspector?.tagName || '-'}</p>
                <p className="truncate">{inspector?.selector || '-'}</p>
                <p className="truncate">{inspector?.componentName || '-'} {inspector?.componentPath || ''}</p>
              </div>

              <div>
                <p className="font-medium">Layout</p>
                <button type="button" className="block text-left" onClick={() => queueInspectorAnnotation('display', inspector?.computedStyles?.display)}>
                  display: {inspector?.computedStyles?.display || '-'}
                </button>
                <button type="button" className="block text-left" onClick={() => queueInspectorAnnotation('width', inspector?.computedStyles?.width)}>
                  width: {inspector?.computedStyles?.width || '-'}
                </button>
                <button type="button" className="block text-left" onClick={() => queueInspectorAnnotation('height', inspector?.computedStyles?.height)}>
                  height: {inspector?.computedStyles?.height || '-'}
                </button>
                <button type="button" className="block text-left" onClick={() => queueInspectorAnnotation('gap', inspector?.computedStyles?.gap)}>
                  gap: {inspector?.computedStyles?.gap || '-'}
                </button>
              </div>

              <div>
                <p className="font-medium">Spacing</p>
                <button type="button" className="block text-left" onClick={() => queueInspectorAnnotation('padding', inspector?.computedStyles?.padding)}>
                  padding: {inspector?.computedStyles?.padding || '-'}
                </button>
                <button type="button" className="block text-left" onClick={() => queueInspectorAnnotation('margin', inspector?.computedStyles?.margin)}>
                  margin: {inspector?.computedStyles?.margin || '-'}
                </button>
              </div>

              <div>
                <p className="font-medium">Typography</p>
                <button type="button" className="block text-left" onClick={() => queueInspectorAnnotation('font-family', inspector?.computedStyles?.fontFamily)}>
                  font-family: {inspector?.computedStyles?.fontFamily || '-'}
                </button>
                <button type="button" className="block text-left" onClick={() => queueInspectorAnnotation('font-size', inspector?.computedStyles?.fontSize)}>
                  font-size: {inspector?.computedStyles?.fontSize || '-'}
                </button>
                <button type="button" className="block text-left" onClick={() => queueInspectorAnnotation('font-weight', inspector?.computedStyles?.fontWeight)}>
                  font-weight: {inspector?.computedStyles?.fontWeight || '-'}
                </button>
                <button type="button" className="block text-left" onClick={() => queueInspectorAnnotation('line-height', inspector?.computedStyles?.lineHeight)}>
                  line-height: {inspector?.computedStyles?.lineHeight || '-'}
                </button>
              </div>

              <div>
                <p className="font-medium">Colors</p>
                <button type="button" className="block text-left" onClick={() => queueInspectorAnnotation('color', inspector?.computedStyles?.color)}>
                  color: {inspector?.computedStyles?.color || '-'}
                </button>
                <button type="button" className="block text-left" onClick={() => queueInspectorAnnotation('background-color', inspector?.computedStyles?.backgroundColor)}>
                  background: {inspector?.computedStyles?.backgroundColor || '-'}
                </button>
                <button type="button" className="block text-left" onClick={() => queueInspectorAnnotation('border', inspector?.computedStyles?.border)}>
                  border: {inspector?.computedStyles?.border || '-'}
                </button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
