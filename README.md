# HarnessChain

업무 프로세스를 **하네스 템플릿**으로 정의하고, AI 에이전트가 자동 실행하는 오케스트레이션 플랫폼.

## 목표

반복적인 데이터 분석·조회 작업을 코드 없이 자동화한다.

1. **하네스 정의** — 소스·도구·서브에이전트를 노드+엣지 그래프로 조합한 워크플로우 템플릿
2. **AI 빌더** — 자연어 한 줄로 하네스 그래프를 자동 설계 (노드 생성→검증→엣지 생성→검증)
3. **AI 실행** — Orchestrator가 Claude를 구동해 하네스를 해석·실행하고 마크다운 리포트 생성
4. **가시성** — 실행 이력, 실시간 상태, 도구 호출 로그를 대시보드에서 확인

---

## 아키텍처

```mermaid
flowchart TB
    subgraph infra["인프라 (docker-compose)"]
        PG["PostgreSQL :5499\npg-sandbox"]
        RD["Redis :6399"]
    end

    subgraph source["Source — 정적 인프라 정의"]
        PG --> SRC["pg-sandbox\ntype: postgresql"]
        SRC -->|"getTools()"| TOOLS["SQL 도구\nexecute_query · explain_query\nget_schema · get_table_sample · get_stats"]
    end

    subgraph store["File Store (data/*.json)"]
        SA_JSON["subagents.json"]
        HN_JSON["harnesses.json\nnodes[] + edges[] 그래프 구조"]
        RN_JSON["runs.json\n실행 이력 (영구 보존)"]
    end

    subgraph builder["AI 하네스 빌더"]
        direction LR
        B1["① 노드 설계 (LLM)"] --> B2["② 노드 검증"]
        B2 --> B3["③ 엣지 설계 (LLM)"]
        B3 --> B4["④ 그래프 검증\n실패 시 재시도"]
        B4 --> B5["⑤ 이름·설명 생성"]
    end

    subgraph orch["Orchestrator (CA AgentLoop + Registry)"]
        ADAPT["HarnessToolAdapter"]
        REG["ToolRegistry\n소스 도구 + SubAgentTool"]
        TOOLS --> ADAPT --> REG
        SA_JSON -->|"런타임 로드 → SubAgentTool 인스턴스화"| REG
    end

    HN_JSON --> EX

    subgraph exec["실행 경로"]
        UI["UI (page.tsx)\n채팅 · 하네스 관리 · 실행 현황"]
        AN["POST /api/analyze\nSSE 스트리밍"]
        GEN["POST /api/harnesses/generate\nAI 빌더"]
        RUN["POST /api/harnesses/{id}/run"]
        EX["Executor\nexecuteHarness()"]

        UI -->|"대화 탭"| AN
        UI -->|"하네스 빌더"| GEN
        UI -->|"하네스 실행"| RUN
        GEN --> builder
        RUN --> EX
        EX -->|"상태 기록"| RN_JSON
        EX -->|"TTL 30m"| RD
        AN --> orch
        EX --> orch
    end
```

### 레이어 설명

| 레이어 | 역할 |
|--------|------|
| **UI** | React SPA. 세션별 채팅, 하네스/서브에이전트 관리, 실행 현황 대시보드 |
| **AI 빌더** | 자연어 프롬프트 → LLM 4단계 파이프라인 → nodes+edges 그래프 자동 생성 |
| **API Routes** | Next.js Route Handlers. SSE 스트리밍, REST CRUD, 하네스 생성 |
| **Executor** | 하네스 실행 진입점. 파일 스토어 + Redis 상태 이중화 |
| **Orchestrator** | `@charming_groot/core` CA SDK 기반 AgentLoop. 서브에이전트 병렬 위임 지원 |
| **Sources** | 외부 데이터 접근 어댑터 (현재: PostgreSQL) |
| **File Store** | JSON 파일 기반 영구 이력 (harnesses, subagents, runs) |
| **Redis** | 실행 중 상태 ephemeral 관리. TTL로 고아 run 자동 감지 |

### 하네스 그래프 구조

하네스는 노드+엣지로 정의된 유향 그래프다.

```
nodes: [
  { id: "n1", kind: "source",   ref: "pg-sandbox",     label: "DB 조회" },
  { id: "n2", kind: "subagent", ref: "sa_vip_analyzer", label: "VIP 분석" },
  { id: "n3", kind: "tool",     ref: "generate_report", label: "리포트 생성" }
]
edges: [
  { id: "e0", from: "__start__", to: "n1" },
  { id: "e1", from: "n1",        to: "n2" },
  { id: "e2", from: "n2",        to: "n3", condition: "위험 고객 존재 시" },
  { id: "e3", from: "n3",        to: "__end__" }
]
```

- `kind`: `source` | `tool` | `subagent`
- 조건부 엣지: `condition` 필드로 분기 설명
- 루프(back-edge) 지원
- `__start__` / `__end__` 가상 노드로 진입·종료점 명시

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
ANTHROPIC_API_KEY=sk-ant-...   # Claude API (권장)
OPENAI_API_KEY=sk-...          # OpenAI API (없으면 Claude로 폴백)
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

### AI 하네스 빌더
- 자연어 한 줄 입력 → AI가 노드·엣지 설계·검증 자동 완료
- 생성 결과를 플로우 그래프로 즉시 미리보기
- Anthropic/OpenAI API 키에 따라 모델 자동 선택 (Haiku / gpt-4o-mini)

### 하네스 (Harness)
- nodes+edges 그래프로 실행 흐름 정의 (조건부 분기·루프 지원)
- 스케줄(cron) 지정으로 자동 반복 실행
- 레거시 steps[] 포맷 자동 마이그레이션

### 서브에이전트 (SubAgent)
- 독립 시스템 프롬프트·도구셋을 가진 전문화 에이전트
- Orchestrator가 병렬로 위임해 처리 속도 향상

### 실행 현황 대시보드
- 최근 50개 실행 이력 조회
- running/completed/failed/평균 소요시간 메트릭
- Redis 기반 실시간 상태 (서버 재시작 후 고아 run 자동 정리)

---

## 프로젝트 구조

```
harness-chain/
├── apps/
│   └── web/                  # Next.js 15 App Router
│       ├── app/
│       │   ├── page.tsx      # 메인 UI (채팅 + 세션 관리)
│       │   └── api/
│       │       ├── analyze/          # SSE 스트리밍 실행
│       │       ├── harnesses/        # 하네스 CRUD
│       │       │   └── generate/     # AI 하네스 자동 생성
│       │       ├── subagents/        # 서브에이전트 CRUD
│       │       ├── queue/            # 실행 이력 + 메트릭
│       │       ├── registry/         # 소스/도구/서브에이전트 목록
│       │       └── scenarios/        # 시나리오 조회
│       ├── lib/
│       │   ├── orchestrator.ts       # CA AgentLoop 래퍼
│       │   ├── executor.ts           # 실행 진입점 + cron 스케줄러
│       │   ├── store.ts              # JSON 파일 스토어 (nodes+edges 그래프)
│       │   ├── run-state.ts          # Redis 실행 상태 레이어
│       │   ├── redis.ts              # ioredis 싱글턴
│       │   └── sources/
│       │       └── postgresql.ts
│       ├── instrumentation.ts        # 서버 시작 시 고아 run 복구
│       └── tests/                    # Vitest (82개)
├── docker-compose.yml                # PostgreSQL + Redis
├── infra/pg/init/                    # DB 초기화 SQL
└── scenarios/                        # 시나리오 JSON 파일
```

---

## 기술 스택

| 영역 | 기술 |
|------|------|
| Frontend | Next.js 15, React, Tailwind CSS |
| AI SDK | `@charming_groot/core` (CA AgentLoop, SubAgentTool) |
| LLM | Claude Haiku (Anthropic) / GPT-4o-mini (OpenAI) |
| DB | PostgreSQL 16 |
| 상태 관리 | Redis 7 (ioredis) |
| 테스트 | Vitest (82개) |
| 패키지 관리 | pnpm workspaces |

---

## 로드맵

- [ ] **Redis 백그라운드 Job 큐** — LLM 생성 작업을 비동기 처리 (세션 이동 후 돌아와도 상태 유지)
- [ ] **SSE 전역 이벤트 스트림** — 루트 레이아웃 마운트, 완료 시 어느 화면에서도 push 알림
- [ ] **빌딩 진행 단계 표시** — 노드 설계 / 검증 / 엣지 설계 / 검증 실시간 체크리스트
- [ ] **CSS 기반 그래프 시각화** — SVG 대신 ReactFlow (드래그·줌·편집 지원)
- [ ] **서브에이전트 AI 빌더** — 자연어로 시스템 프롬프트·도구셋 자동 구성
