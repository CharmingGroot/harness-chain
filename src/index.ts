#!/usr/bin/env node
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import * as readline from 'node:readline/promises';
import { Orchestrator } from './core/orchestrator.js';
import { SourceRegistry } from './core/source.js';
import { createPostgreSQLSourceFromEnv } from './sources/postgresql.js';

// ── Scenario imports ─────────────────────────────────────────────────────────
import { scenario as s1 } from '../scenarios/01-vip-churn.js';
import { scenario as s2 } from '../scenarios/02-fraud-detection.js';
import { scenario as s3 } from '../scenarios/03-query-optimization.js';
import { scenario as s4 } from '../scenarios/04-loan-default-risk.js';
import { scenario as s5 } from '../scenarios/05-portfolio-pnl.js';

const SCENARIOS = [s1, s2, s3, s4, s5];

// ── Setup ─────────────────────────────────────────────────────────────────────

function buildOrchestrator(verbose = true): Orchestrator {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 환경 변수가 설정되지 않았습니다.');

  const registry = new SourceRegistry();

  // pg-sandbox 금융 DB 소스 등록
  registry.register(
    createPostgreSQLSourceFromEnv(
      'pg-sandbox',
      'pg-sandbox 금융 DB',
      [
        '금융 도메인 PostgreSQL 데이터베이스입니다.',
        '다음 테이블이 포함됩니다:',
        '- customers: 고객 정보 (등급, 자산, 신용점수, 가입일 등) — 약 10만 건',
        '- transactions: 거래 내역 (금액, 일시, 가맹점, 카테고리 등) — 약 200만 건',
        '- accounts: 계좌 정보 (잔액, 유형, 상태 등)',
        '- loans: 대출 정보 (원금, 이자율, 상태, 만기일 등)',
        '- investments: 투자 포트폴리오 (자산 유형, 수익률 등)',
        '금융 분석, 이상 거래 탐지, 고객 세그멘테이션, 포트폴리오 분석에 적합합니다.',
      ].join(' '),
    )
  );

  return new Orchestrator({
    client: new Anthropic({ apiKey }),
    sources: registry.getAll(),
    maxIterations: 25,
    verbose,
  });
}

// ── Interactive mode ──────────────────────────────────────────────────────────

async function interactiveMode(): Promise<void> {
  console.log('\n┌─────────────────────────────────────────────────────────┐');
  console.log('│           김대리 — 자율 데이터 분석 에이전트              │');
  console.log('└─────────────────────────────────────────────────────────┘\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const orchestrator = buildOrchestrator(true);

    while (true) {
      const request = await rl.question('\n분석 요청을 입력하세요 (종료: exit)\n> ');
      if (request.trim().toLowerCase() === 'exit') break;
      if (!request.trim()) continue;

      const start = Date.now();
      try {
        const result = await orchestrator.run(request);
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);

        console.log('\n' + '═'.repeat(60));
        console.log(result.report);
        console.log('═'.repeat(60));
        console.log(`\n⏱  ${elapsed}s | 소스: ${result.sourcesUsed.join(', ')} | 툴 호출: ${result.toolCallCount}회 | 반복: ${result.iterations}회`);
      } catch (err) {
        console.error('\n오류:', err instanceof Error ? err.message : String(err));
      }
    }
  } finally {
    rl.close();
  }
}

// ── Scenario mode ─────────────────────────────────────────────────────────────

async function scenarioMode(scenarioId?: string): Promise<void> {
  const scenarios = scenarioId
    ? SCENARIOS.filter(s => s.id === scenarioId)
    : SCENARIOS;

  if (scenarios.length === 0) {
    console.error(`시나리오를 찾을 수 없습니다: ${scenarioId}`);
    console.error('사용 가능한 시나리오:', SCENARIOS.map(s => s.id).join(', '));
    process.exit(1);
  }

  const orchestrator = buildOrchestrator(true);

  for (const scenario of scenarios) {
    console.log('\n' + '═'.repeat(60));
    console.log(`📋 시나리오: ${scenario.title}`);
    console.log('═'.repeat(60));

    const start = Date.now();
    try {
      const result = await orchestrator.run(scenario.request);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);

      // 파일로 저장
      const outDir = 'output';
      const { mkdir, writeFile } = await import('node:fs/promises');
      await mkdir(outDir, { recursive: true });
      const filename = `${outDir}/${scenario.id}-${new Date().toISOString().slice(0, 10)}.md`;
      const content = [
        `# ${scenario.title}`,
        `> 생성일시: ${new Date().toLocaleString('ko-KR')}`,
        `> 소스: ${result.sourcesUsed.join(', ')} | 툴 호출: ${result.toolCallCount}회 | 소요시간: ${elapsed}s`,
        '',
        result.report,
      ].join('\n');

      await writeFile(filename, content, 'utf-8');

      console.log('\n' + result.report);
      console.log(`\n✅ 저장됨: ${filename} (${elapsed}s)`);
    } catch (err) {
      console.error(`\n❌ 오류: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ── Entry ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--scenario') || args.includes('-s')) {
    const idx = args.findIndex(a => a === '--scenario' || a === '-s');
    const scenarioId = args[idx + 1]?.startsWith('-') ? undefined : args[idx + 1];
    await scenarioMode(scenarioId);
  } else if (args.length > 0 && !args[0].startsWith('-')) {
    // 직접 요청 전달: node index.js "VIP 고객 분석해줘"
    const request = args.join(' ');
    const orchestrator = buildOrchestrator(true);
    const result = await orchestrator.run(request);
    console.log('\n' + result.report);
  } else {
    await interactiveMode();
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
