# Design Playground

> 디자이너가 배포된 UI 위에서 AI 에이전트와 대화하며 코드를 수정하고, PR로 제출하는 웹 서비스

## Overview

개발자가 Figma → 코드 전환을 완료하고 `dev` 브랜치에 머지한 이후, 디자이너가 직접 세부 조정을 할 수 있는 환경을 제공한다. 디자이너는 코드를 모르더라도 실제 렌더링된 화면 위에서 컴포넌트를 선택하고, 자연어로 수정을 요청하며, 결과를 PR로 제출한다.

## User Flow

```
1. 디자이너가 웹 서비스에 로그인 (GitHub OAuth)
2. 작업할 프로젝트 선택
3. "새 세션 시작" → 대상 repo의 dev 브랜치를 기반으로 worktree 생성
4. 서버가 해당 worktree에서 dev server 실행
5. 디자이너에게 프리뷰 URL 제공 (오버레이 포함)
6. 디자이너가 컴포넌트를 클릭하고 에이전트와 대화하며 수정
7. 수정 완료 시 PR 생성 (base: dev)
8. 세션 종료 → worktree 정리
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (디자이너)                                           │
│                                                              │
│  ┌────────────────────────┐  ┌────────────────────────────┐ │
│  │  프리뷰 iframe          │  │  사이드 패널                 │ │
│  │  (dev server 렌더링)    │  │  - 컴포넌트 정보             │ │
│  │                        │  │  - 에이전트 채팅              │ │
│  │  + 오버레이 레이어       │  │  - 변경 히스토리             │ │
│  │    (컴포넌트 인스펙터)   │  │  - PR 제출 버튼             │ │
│  └────────────────────────┘  └────────────────────────────┘ │
└──────────────────────────────┬──────────────────────────────┘
                               │
                    HTTPS / WebSocket
                               │
┌──────────────────────────────┴──────────────────────────────┐
│  Backend Server                                              │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐ │
│  │  Session      │  │  Agent       │  │  Dev Server       │ │
│  │  Manager      │  │  Service     │  │  Manager          │ │
│  │              │  │              │  │                   │ │
│  │  - worktree  │  │  - Claude    │  │  - 프로세스 관리   │ │
│  │    생성/삭제  │  │    API 호출  │  │  - 포트 할당      │ │
│  │  - 브랜치    │  │  - 파일 R/W  │  │  - 헬스체크       │ │
│  │    관리      │  │  - Git 명령  │  │  - 프록시         │ │
│  └──────────────┘  └──────────────┘  └───────────────────┘ │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐                         │
│  │  Auth        │  │  Storage     │                         │
│  │  (GitHub     │  │  (SQLite/    │                         │
│  │   OAuth)     │  │   Redis)     │                         │
│  └──────────────┘  └──────────────┘                         │
│                                                              │
│  File System:                                                │
│  /data/repos/{project}/           ← bare clone (공유)        │
│  /data/sessions/{session-id}/     ← worktree (세션별 격리)   │
└─────────────────────────────────────────────────────────────┘
                               │
                          GitHub API
                               │
                    ┌──────────┴──────────┐
                    │  Target Repository   │
                    │  (dev branch)        │
                    └─────────────────────┘
```

## Core Components

### 1. Auth Service

- GitHub OAuth 로그인
- 사용자별 GitHub Personal Access Token 저장 (암호화)
- repo 접근 권한 확인
- 역할: `designer`, `developer`, `admin`

### 2. Project Registry

프로젝트(대상 repo) 등록 및 설정 관리.

```yaml
# 프로젝트 설정 예시
project:
  name: "my-web-app"
  repo: "org/my-web-app"
  base_branch: "dev"          # worktree 생성 기준 브랜치
  pr_target: "dev"            # PR 대상 브랜치
  dev_server:
    install_command: "pnpm install"
    start_command: "pnpm dev"
    port: 3000
    ready_check: "http://localhost:{port}"
    env_file: ".env.development"
  overlay:
    framework: "react"        # react | vue | svelte | html
    inspector: true
  agent:
    model: "claude-sonnet-4-6"
    context_files:             # 에이전트에게 항상 제공할 파일
      - "CLAUDE.md"
      - "src/styles/tokens.css"
      - "src/styles/theme.ts"
    rules:                     # 에이전트 행동 규칙
      - "디자인 토큰(CSS Custom Properties)을 우선 사용할 것"
      - "하드코딩된 색상/간격 값 사용 금지"
      - "기존 컴포넌트 API(props)를 변경하지 말 것"
```

### 3. Session Manager

세션의 전체 생명주기를 관리.

```
생성 (create)
  │
  ├→ git fetch origin dev
  ├→ git worktree add /data/sessions/{id} -b design/{user}-{id} origin/dev
  ├→ install dependencies
  ├→ start dev server (포트 동적 할당)
  ├→ ready_check 대기
  │
작업중 (active)
  │
  ├→ 에이전트가 worktree 내 파일 수정
  ├→ dev server hot-reload로 즉시 반영
  ├→ 변경마다 자동 커밋 (squash 가능)
  │
제출 (submit)
  │
  ├→ git push origin design/{user}-{id}
  ├→ gh pr create --base dev
  ├→ PR에 변경 전/후 스크린샷 첨부
  │
정리 (cleanup)
  │
  ├→ dev server 프로세스 종료
  ├→ git worktree remove
  ├→ 세션 메타데이터 archived로 변경
```

**자동 정리 정책:**
- 2시간 무활동 시 자동 정리
- 최대 동시 세션 수: 설정 가능 (기본 10)
- 세션당 최대 수명: 24시간

### 4. Dev Server Manager

각 세션의 dev server 프로세스를 관리.

- **포트 할당**: 세션 생성 시 3001~3100 범위에서 미사용 포트 자동 할당
- **프로세스 관리**: child_process로 실행, PID 추적, 비정상 종료 시 재시작
- **리버스 프록시**: 메인 서버가 `/session/{id}/preview/*` 경로를 해당 포트로 프록시
- **오버레이 주입**: 프록시 응답의 `</body>` 앞에 오버레이 스크립트 삽입

```
브라우저 요청:  https://playground.example.com/session/abc123/preview/
     ↓ 리버스 프록시
localhost:3042  (세션 abc123의 dev server)
     ↓ 응답에 오버레이 스크립트 삽입
브라우저에 렌더링 (오버레이 포함)
```

### 5. Browser Overlay

QA 페이지 위에 올라가는 클라이언트 스크립트.

**컴포넌트 인스펙터:**
- React: `__REACT_DEVTOOLS_GLOBAL_HOOK__`으로 fiber tree 접근
- 빌드 시 `babel-plugin-source` 또는 커스텀 플러그인으로 `data-source-file`, `data-source-line` 속성 주입
- hover 시 컴포넌트 경계 하이라이트 (border overlay)
- 클릭 시 컴포넌트 정보 패널에 표시:
  - 파일 경로
  - 컴포넌트 이름
  - 현재 props
  - 적용된 CSS 변수/클래스

**채팅 패널:**
- 선택된 컴포넌트가 자동으로 컨텍스트에 포함
- 스트리밍 응답 표시
- 변경 전/후 diff 표시
- "적용" → hot-reload로 즉시 반영
- "되돌리기" → git checkout으로 복원
- "PR 제출" → 세션 제출 플로우

### 6. Agent Service

디자이너의 요청을 코드 변경으로 변환.

**요청 처리 흐름:**
```
디자이너 메시지 + 선택된 컴포넌트 정보
     ↓
컨텍스트 조립:
  - 대상 컴포넌트 파일 내용
  - 관련 스타일/토큰 파일
  - 프로젝트 에이전트 규칙
  - 이전 대화 히스토리
     ↓
Claude API 호출 (tool use)
  tools:
    - read_file(path)
    - write_file(path, content)
    - list_files(pattern)
    - search_code(query)
    - get_component_tree(path)
     ↓
파일 변경 → dev server hot-reload
     ↓
변경 diff + 결과 스크린샷 응답
```

**에이전트 Tool 정의:**

| Tool | 설명 |
|---|---|
| `read_file` | worktree 내 파일 읽기 |
| `write_file` | worktree 내 파일 쓰기 (자동 커밋) |
| `list_files` | glob 패턴으로 파일 검색 |
| `search_code` | ripgrep으로 코드 내 텍스트 검색 |
| `get_component_tree` | AST 파싱으로 컴포넌트 구조 반환 |
| `get_design_tokens` | 프로젝트의 디자인 토큰 목록 반환 |
| `take_screenshot` | 현재 페이지 스크린샷 캡처 (Puppeteer) |
| `git_diff` | 현재까지의 변경사항 diff 반환 |
| `git_undo` | 마지막 변경 되돌리기 |

## Data Models

### Session

```typescript
interface Session {
  id: string
  userId: string
  projectId: string
  status: 'creating' | 'active' | 'submitting' | 'archived' | 'error'
  worktreePath: string
  branch: string
  devServerPort: number
  devServerPid: number | null
  createdAt: Date
  lastActiveAt: Date
  expiresAt: Date
  componentsTouched: string[]
  commitCount: number
  prUrl: string | null
}
```

### ChatMessage

```typescript
interface ChatMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: string
  componentContext: {
    filePath: string
    componentName: string
    props: Record<string, unknown>
  } | null
  changes: FileChange[] | null
  timestamp: Date
}

interface FileChange {
  filePath: string
  diff: string
  type: 'modified' | 'created' | 'deleted'
}
```

### Project

```typescript
interface Project {
  id: string
  name: string
  repoFullName: string        // "org/repo-name"
  baseBranch: string
  prTargetBranch: string
  devServerConfig: {
    installCommand: string
    startCommand: string
    port: number
    readyCheck: string
    envFile: string | null
  }
  overlayConfig: {
    framework: 'react' | 'vue' | 'svelte' | 'html'
    inspector: boolean
  }
  agentConfig: {
    model: string
    contextFiles: string[]
    rules: string[]
  }
  createdAt: Date
  updatedAt: Date
}
```

## API Endpoints

### Auth
```
GET  /auth/github              → GitHub OAuth 시작
GET  /auth/github/callback     → OAuth 콜백
GET  /auth/me                  → 현재 사용자 정보
POST /auth/logout              → 로그아웃
```

### Projects
```
GET    /api/projects           → 프로젝트 목록
POST   /api/projects           → 프로젝트 등록
GET    /api/projects/:id       → 프로젝트 상세
PUT    /api/projects/:id       → 프로젝트 설정 수정
DELETE /api/projects/:id       → 프로젝트 삭제
```

### Sessions
```
POST   /api/sessions                    → 세션 생성 (worktree + dev server 시작)
GET    /api/sessions                    → 내 세션 목록
GET    /api/sessions/:id                → 세션 상세
DELETE /api/sessions/:id                → 세션 삭제 (정리)
POST   /api/sessions/:id/submit        → PR 생성 및 제출
GET    /api/sessions/:id/diff           → 현재까지 변경사항
POST   /api/sessions/:id/undo          → 마지막 변경 되돌리기
```

### Agent Chat
```
POST   /api/sessions/:id/chat          → 에이전트에게 메시지 전송 (SSE 스트리밍)
GET    /api/sessions/:id/chat/history   → 채팅 히스토리
```

### Preview Proxy
```
GET    /session/:id/preview/*          → dev server 리버스 프록시 (오버레이 주입)
```

## Tech Stack

| 레이어 | 기술 | 이유 |
|---|---|---|
| **Backend** | Node.js (Fastify) | child_process로 dev server 관리, 스트리밍 지원 |
| **Frontend** | React + Vite | 대시보드 UI |
| **Overlay** | Vanilla JS + Preact | 번들 크기 최소화, 프레임워크 충돌 방지 |
| **DB** | SQLite (better-sqlite3) | 단일 서버, 외부 의존성 없음 |
| **Cache** | 인메모리 (Map) | 세션 메타데이터 빠른 조회 |
| **AI** | Claude API (Anthropic SDK) | tool use 지원, 코드 생성 품질 |
| **Git** | simple-git (Node.js) | worktree, branch, commit 관리 |
| **GitHub** | Octokit | PR 생성, repo 접근 |
| **Proxy** | http-proxy | dev server 리버스 프록시 |
| **Screenshot** | Puppeteer | PR용 변경 전/후 스크린샷 |

## File Structure

```
design-playground/
├── SPEC.md
├── package.json
├── tsconfig.json
├── .env.example
│
├── src/
│   ├── server/                    # Backend
│   │   ├── index.ts               # Fastify 서버 엔트리
│   │   ├── auth/
│   │   │   ├── github-oauth.ts
│   │   │   └── middleware.ts
│   │   ├── projects/
│   │   │   ├── routes.ts
│   │   │   └── service.ts
│   │   ├── sessions/
│   │   │   ├── routes.ts
│   │   │   ├── service.ts
│   │   │   ├── worktree.ts        # Git worktree 관리
│   │   │   ├── dev-server.ts      # Dev server 프로세스 관리
│   │   │   └── cleanup.ts         # 자동 정리 스케줄러
│   │   ├── agent/
│   │   │   ├── routes.ts
│   │   │   ├── service.ts         # Claude API 호출
│   │   │   ├── tools.ts           # 에이전트 tool 정의
│   │   │   └── context.ts         # 컨텍스트 조립
│   │   ├── proxy/
│   │   │   ├── preview.ts         # 리버스 프록시
│   │   │   └── overlay-inject.ts  # 오버레이 스크립트 삽입
│   │   └── db/
│   │       ├── schema.ts
│   │       └── client.ts
│   │
│   ├── dashboard/                 # Frontend (React)
│   │   ├── index.html
│   │   ├── App.tsx
│   │   ├── pages/
│   │   │   ├── Login.tsx
│   │   │   ├── Projects.tsx
│   │   │   ├── Sessions.tsx
│   │   │   └── Session.tsx        # 프리뷰 + 채팅 메인 화면
│   │   └── components/
│   │       ├── ChatPanel.tsx
│   │       ├── DiffViewer.tsx
│   │       └── ComponentInfo.tsx
│   │
│   └── overlay/                   # 프리뷰 페이지에 삽입되는 스크립트
│       ├── index.ts               # 엔트리
│       ├── inspector.ts           # 컴포넌트 인스펙터
│       ├── highlighter.ts         # hover/select 하이라이트
│       ├── bridge.ts              # 메인 서버와 WebSocket 통신
│       └── ui.ts                  # 오버레이 UI (Preact)
│
├── scripts/
│   ├── setup-babel-plugin.ts      # 대상 프로젝트에 source 플러그인 추가
│   └── seed.ts                    # 테스트 데이터
│
└── data/                          # gitignore, 런타임 데이터
    ├── repos/                     # bare clone 저장
    └── sessions/                  # worktree 저장
```

## Environment Variables

```bash
# .env.example

# Server
PORT=4000
HOST=0.0.0.0
BASE_URL=http://localhost:4000

# GitHub OAuth
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_CALLBACK_URL=http://localhost:4000/auth/github/callback

# Claude API
ANTHROPIC_API_KEY=

# Session
SESSION_SECRET=
MAX_CONCURRENT_SESSIONS=10
SESSION_TIMEOUT_HOURS=2
SESSION_MAX_LIFETIME_HOURS=24

# File System
DATA_DIR=/data
REPOS_DIR=/data/repos
SESSIONS_DIR=/data/sessions

# Dev Server
DEV_SERVER_PORT_RANGE_START=3001
DEV_SERVER_PORT_RANGE_END=3100
```

## Security Considerations

- GitHub OAuth token은 AES-256으로 암호화하여 저장
- 에이전트의 파일 접근은 worktree 디렉토리 내로 제한 (path traversal 방지)
- dev server는 localhost 바인딩, 외부 직접 접근 불가
- 세션 프리뷰 URL은 인증된 사용자만 접근 가능
- 에이전트 tool의 write_file은 worktree 외부 경로 차단
- rate limiting: 에이전트 채팅 분당 30회 제한

## Future Considerations

- **멀티 서버**: 세션이 많아지면 여러 서버에 분산 (세션 라우팅 필요)
- **컨테이너화**: 각 세션을 Docker 컨테이너로 격리 (보안 강화)
- **Figma 연동**: Figma MCP로 디자인 변경 → 자동 반영
- **비교 뷰**: dev 브랜치 원본과 수정본 side-by-side 비교
- **디자인 토큰 대시보드**: 프로젝트의 디자인 토큰을 시각적으로 탐색/수정
- **팀 세션**: 여러 디자이너가 같은 세션에서 협업
