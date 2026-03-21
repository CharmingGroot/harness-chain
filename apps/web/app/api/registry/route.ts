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
];

// Static tool definitions — backed by sql-tools.ts implementations
const TOOLS = [
  { id: 'execute_query',    name: 'execute_query',    category: 'database',      description: 'SQL 쿼리 실행' },
  { id: 'explain_query',   name: 'explain_query',    category: 'database',      description: '쿼리 실행계획 분석' },
  { id: 'get_schema',      name: 'get_schema',       category: 'database',      description: 'DB 스키마 조회' },
  { id: 'get_table_sample',name: 'get_table_sample', category: 'database',      description: '테이블 샘플 조회' },
  { id: 'get_stats',       name: 'get_stats',        category: 'database',      description: 'DB 성능 통계' },
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
