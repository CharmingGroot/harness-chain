# HarnessChain

업무 프로세스를 **하네스 템플릿**으로 정의하고, AI 에이전트가 자동 실행하는 오케스트레이션 플랫폼.

## 목표

반복적인 데이터 분석·조회 작업을 코드 없이 자동화한다.

1. **하네스 정의** — 소스(PostgreSQL 등)·도구·서브에이전트를 단계별로 조합한 워크플로우 템플릿
2. **AI 실행** — Orchestrator가 Claude를 구동해 하네스를 해석·실행하고 마크다운 리포트를 생성
3. **가시성** — 실행 이력, 실시간 상태, 도구 호출 로그를 대시보드에서 확인

---

## 아키텍처

```
┌─────────────────────────────────────────────────────────┐
│                    Next.js App (apps/web)                │
│                                                          │
│  ┌──────────┐   ┌──────────────────────────────────┐    │
│  │  UI      │   │  API Routes                       │    │
│  │ page.tsx │──▶│  /api/analyze   SSE 스트리밍      │    │
│  │ (React)  │   │  /api/harnesses CRUD              │    │
│  └──────────┘   │  /api/queue     실행 이력         │    │
│                 │  /api/registry  소스/도구 목록    │    │
│                 └──────────┬─────────────────────────┘   │
│                            │                             │
│              ┌─────────────▼──────────────┐             │
│              │       Executor             │             │
│              │  executeHarness()          │             │
│              │  markRunning() → Redis     │             │
│              └─────────────┬──────────────┘             │
│                            │                             │
│              ┌─────────────▼──────────────┐             │
│              │      Orchestrator          │             │
│              │  AgentLoop (CA SDK)        │             │
│              │  SubAgentTool (병렬 위임)  │             │
│              └──┬──────────┬──────────────┘             │
│                 │          │                             │
│         ┌───────▼──┐  ┌────▼────────┐                  │
│         │  Source   │  │  SubAgent   │                  │
│         │PostgreSQL │  │ (CA Agent)  │                  │
│         └───────────┘  └─────────────┘                  │
└─────────────────────────────────────────────────────────┘

┌───────────────────┐   ┌────────────────────────────────┐
│  File Store       │   │  Redis (hc-redis :6399)        │
│  data/*.json      │   │  hc:run:{id}  Hash + TTL 30m   │
│  - harnesses.json │   │  hc:active    Set (실행중 ID)  │
│  - subagents.json │   │                                │
│  - runs.json      │   │  서버 재시작 시 자동 만료 →    │
│  (영구 이력)      │   │  파일 스토어에 failed 기록     │
└───────────────────┘   └────────────────────────────────┘
```

### 레이어 설명

| 레이어 | 역할 |
|--------|------|
| **UI** | React SPA. 세션별 채팅, 하네스/서브에이전트 관리, 실행 큐 대시보드 |
| **API Routes** | Next.js Route Handlers. SSE 스트리밍(`/api/analyze`), REST CRUD |
| **Executor** | 하네스 실행 진입점. 파일 스토어 + Redis 상태 이중화 |
| **Orchestrator** | `@charming_groot/core` CA SDK 기반 AgentLoop. 서브에이전트 병렬 위임 지원 |
| **Sources** | 외부 데이터 접근 어댑터 (현재: PostgreSQL) |
| **File Store** | JSON 파일 기반 영구 이력 (harnesses, subagents, runs) |
| **Redis** | 실행 중 상태 ephemeral 관리. TTL로 고아 run 자동 감지 |

### 상태 이중화 설계

```
실행 시작  → 파일 스토어: status=running
             Redis: hc:run:{id} TTL=30m, hc:active sadd

완료/실패  → 파일 스토어: status=completed|failed
             Redis: DEL hc:run:{id}, srem hc:active

서버 재시작 → instrumentation.ts recoverOrphanedRuns()
              파일=running AND Redis=없음 → 파일을 failed로 갱신
```

---

## 실행 방법

### 1. 인프라 기동

```bash
docker compose up -d
```

- PostgreSQL 16: `localhost:5499`
- Redis 7: `localhost:6399`

### 2. 환경 변수

```bash
# apps/web/.env.local
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_URL=postgresql://sandbox:sandbox@localhost:5499/sandbox
REDIS_URL=redis://localhost:6399
```

### 3. 개발 서버

```bash
pnpm install
pnpm --filter web dev   # localhost:3000
```

---

## 주요 기능

### 하네스 (Harness)
- 소스 조회 → 도구 실행 → 서브에이전트 위임 단계를 순서대로 정의
- 스케줄(cron) 지정으로 자동 반복 실행

### 서브에이전트 (SubAgent)
- 독립 시스템 프롬프트·도구셋을 가진 전문화 에이전트
- Orchestrator가 병렬로 위임해 처리 속도 향상

### 실행 큐 대시보드
- 최근 50개 실행 이력 조회
- running/completed/failed/평균 소요시간 메트릭
- Redis 기반 실시간 상태 (서버 재시작 후 고아 run 자동 정리)

### SSE 스트리밍
- `/api/analyze` → `text/event-stream`
- 도구 호출·서브에이전트 위임·리포트 이벤트를 실시간 스트리밍

---

## 프로젝트 구조

```
harness-chain/
├── apps/
│   └── web/                  # Next.js 15 App Router
│       ├── app/
│       │   ├── page.tsx      # 메인 UI (채팅 + 세션 관리)
│       │   └── api/
│       │       ├── analyze/  # SSE 스트리밍 실행
│       │       ├── harnesses/# 하네스 CRUD
│       │       ├── subagents/# 서브에이전트 CRUD
│       │       ├── queue/    # 실행 이력 + 메트릭
│       │       ├── registry/ # 소스/도구 목록
│       │       └── scenarios/# 시나리오 조회
│       ├── lib/
│       │   ├── orchestrator.ts  # CA AgentLoop 래퍼
│       │   ├── executor.ts      # 실행 진입점 + cron 스케줄러
│       │   ├── store.ts         # JSON 파일 스토어
│       │   ├── run-state.ts     # Redis 실행 상태 레이어
│       │   ├── redis.ts         # ioredis 싱글턴
│       │   ├── ca-adapter.ts    # CA SDK ↔ ISource 어댑터
│       │   └── sources/
│       │       └── postgresql.ts
│       ├── instrumentation.ts   # 서버 시작 시 고아 run 복구
│       └── tests/               # Vitest 테스트
├── docker-compose.yml           # PostgreSQL + Redis
├── infra/pg/init/               # DB 초기화 SQL
└── scenarios/                   # 시나리오 JSON 파일
```

---

## 기술 스택

| 영역 | 기술 |
|------|------|
| Frontend | Next.js 15, React, Tailwind CSS |
| AI SDK | `@charming_groot/core` (CA AgentLoop, SubAgentTool) |
| LLM | Claude (Anthropic API) |
| DB | PostgreSQL 16 |
| 상태 관리 | Redis 7 (ioredis) |
| 테스트 | Vitest |
| 패키지 관리 | pnpm workspaces |
