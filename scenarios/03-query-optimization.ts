export const scenario = {
  id: '03-query-optimization',
  title: 'DB 쿼리 성능 최적화 보고서',
  description: '주요 테이블의 인덱스 사용률과 쿼리 성능을 분석해 최적화 방안을 제안합니다.',
  request: `
DB 쿼리 성능 최적화 보고서를 작성해줘.

분석 요구사항:
1. 각 테이블의 크기, 행 수, seq_scan vs idx_scan 비율
2. seq_scan이 많은 테이블의 주요 조회 컬럼 분석
3. transactions 테이블 주요 쿼리 패턴에 대한 EXPLAIN 분석
   - 날짜 범위 조회: WHERE transaction_date >= '2024-01-01'
   - 고객별 합계: WHERE customer_id = ? GROUP BY ...
   - 금액 범위 조회: WHERE amount BETWEEN x AND y
4. 누락된 인덱스 제안 (예상 쿼리 패턴 기반)
5. 현재 인덱스 중 불필요하거나 중복된 항목

각 개선사항의 예상 성능 향상 효과와 적용 우선순위를 함께 제시해줘.
  `.trim(),
};
