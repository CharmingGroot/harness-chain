import { NextResponse } from 'next/server';
import { listSubAgents } from '@/lib/store';

// Static source definitions (these are infrastructure-level, not user-created)
const SOURCES = [
  {
    id: 'pg-sandbox',
    name: 'pg-sandbox',
    type: 'postgresql',
    description: '금융 도메인 PostgreSQL DB (customers, transactions, loans, investments)',
    status: 'connected',
    tables: ['customers', 'transactions', 'accounts', 'loans', 'investments'],
  },
  // Dummy sources for harness builder testing
  {
    id: 'mock-crm',
    name: 'mock-crm',
    type: 'mock',
    description: '[더미] CRM 고객 데이터 소스 — 고객 프로파일, 상담 이력, 세그먼트 정보',
    status: 'mock',
  },
  {
    id: 'mock-marketing',
    name: 'mock-marketing',
    type: 'mock',
    description: '[더미] 마케팅 이벤트 소스 — 캠페인 반응률, 클릭 이벤트, 전환 데이터',
    status: 'mock',
  },
  {
    id: 'mock-external-api',
    name: 'mock-external-api',
    type: 'mock',
    description: '[더미] 외부 API 소스 — REST 엔드포인트 응답 데이터 조회',
    status: 'mock',
  },
];

// Static tool definitions — backed by sql-tools.ts implementations
const TOOLS = [
  { id: 'execute_query',    name: 'execute_query',    category: 'database',      description: 'SQL 쿼리 실행' },
  { id: 'explain_query',   name: 'explain_query',    category: 'database',      description: '쿼리 실행계획 분석' },
  { id: 'get_schema',      name: 'get_schema',       category: 'database',      description: 'DB 스키마 조회' },
  { id: 'get_table_sample',name: 'get_table_sample', category: 'database',      description: '테이블 샘플 조회' },
  { id: 'get_stats',       name: 'get_stats',        category: 'database',      description: 'DB 성능 통계' },
  // Dummy tools for harness builder testing
  { id: 'classify_risk',   name: 'classify_risk',    category: 'analysis',      description: '[더미] 위험 등급 분류 — 입력 데이터에 대해 LOW/MEDIUM/HIGH 판정' },
  { id: 'summarize_text',  name: 'summarize_text',   category: 'analysis',      description: '[더미] 텍스트 요약 — 장문 보고서를 3줄 요약으로 압축' },
  { id: 'score_customer',  name: 'score_customer',   category: 'analysis',      description: '[더미] 고객 스코어링 — 이탈/연체/VIP 전환 가능성 0~100 점수 산출' },
  { id: 'generate_report', name: 'generate_report',  category: 'output',        description: '[더미] 리포트 생성 — 마크다운 형식 최종 보고서 작성' },
  { id: 'send_alert',      name: 'send_alert',       category: 'output',        description: '[더미] 알림 발송 — 임계값 초과 시 담당자에게 알림' },
  { id: 'http_request',    name: 'http_request',     category: 'integration',   description: 'HTTP API 호출',        comingSoon: true },
  { id: 'slack_notify',    name: 'slack_notify',     category: 'notification',  description: 'Slack 메시지 전송',     comingSoon: true },
  { id: 'email_send',      name: 'email_send',       category: 'notification',  description: '이메일 전송',           comingSoon: true },
  { id: 'write_file',      name: 'write_file',       category: 'storage',       description: '파일 저장',             comingSoon: true },
];

export async function GET() {
  // Sub-agents come from the persistent store — always up-to-date
  const subAgents = listSubAgents();
  return NextResponse.json({ sources: SOURCES, tools: TOOLS, subAgents });
}
