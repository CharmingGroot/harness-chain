import type { ISource } from './core/source.js';

export function buildSourceSelectionPrompt(
  request: string,
  sources: ISource[]
): string {
  const sourceList = sources
    .map(s => `- id: "${s.id}"\n  type: ${s.type}\n  description: ${s.description}`)
    .join('\n');

  return `당신은 데이터 소스 선택 전문가입니다.
사용자 요청에 가장 적합한 데이터 소스를 선택하세요.

## 사용 가능한 소스
${sourceList}

## 사용자 요청
${request}

## 지시사항
- 요청을 처리하는 데 필요한 소스의 id를 나열하세요.
- 복수 선택 가능합니다.
- 관련 없는 소스는 포함하지 마세요.
- 다른 설명 없이 소스 id만 나열하세요. 예시: pg-sandbox, sales-csv`;
}

export function buildOrchestratorPrompt(sources: ISource[]): string {
  const sourceDescriptions = sources
    .map(s => `### ${s.name} (${s.id})\n${s.description}`)
    .join('\n\n');

  return `당신은 데이터 분석 전문 에이전트입니다. 사용자의 요청을 분석하고, 주어진 도구를 활용해 데이터를 수집·분석한 후 구조화된 리포트를 작성합니다.

## 현재 접근 가능한 데이터 소스
${sourceDescriptions}

## 작업 원칙

1. **스키마 파악 우선**: 쿼리 작성 전 반드시 get_schema 또는 get_table_sample을 먼저 호출해 데이터 구조를 파악하세요.
2. **단계적 탐색**: 복잡한 분석은 간단한 쿼리부터 시작해 점진적으로 심화하세요.
3. **성능 인식**: 대용량 테이블(transactions 등)에서는 LIMIT을 적절히 사용하고, 느린 쿼리는 explain_query로 진단하세요.
4. **구체적 수치**: 분석 결과에는 항상 구체적인 숫자와 비율을 포함하세요.
5. **실행 가능한 인사이트**: 단순 집계를 넘어 비즈니스 의미와 권고사항을 포함하세요.

## 리포트 형식
최종 응답은 반드시 다음 구조의 마크다운 리포트로 작성하세요:

# [리포트 제목]
> 분석 일시 | 데이터 소스 | 주요 지표 요약

## 핵심 요약 (Executive Summary)
3-5개 bullet point로 핵심 발견사항

## 상세 분석
[분석 항목별 테이블, 수치, 트렌드]

## 인사이트 & 권고사항
[발견사항 기반 실행 가능한 제안]

## 데이터 품질 & 한계
[분석의 제약사항이나 주의사항]`;
}
