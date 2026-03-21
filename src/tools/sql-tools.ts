import pg from 'pg';
import { z } from 'zod';
import type { ITool, ToolResult } from '../core/tool.js';

const { Pool } = pg;

export type PgPool = InstanceType<typeof Pool>;

// ── execute_query ─────────────────────────────────────────────────────────────

const ExecuteQueryInput = z.object({
  sql: z.string().describe('실행할 SQL 쿼리'),
  limit: z.number().optional().describe('최대 반환 행 수 (기본 200, 최대 2000)'),
});

export class ExecuteQueryTool implements ITool<z.infer<typeof ExecuteQueryInput>> {
  readonly name = 'execute_query';
  readonly description =
    'SQL 쿼리를 실행하고 결과를 반환합니다. SELECT 쿼리에 자동으로 LIMIT을 적용합니다.';
  readonly inputSchema = ExecuteQueryInput;

  constructor(private readonly pool: PgPool) {}

  async execute(input: z.infer<typeof ExecuteQueryInput>): Promise<ToolResult> {
    const limit = Math.min(input.limit ?? 200, 2000);
    let sql = input.sql.trim().replace(/;$/, '');

    if (/^SELECT/i.test(sql) && !/LIMIT\s+\d+/i.test(sql)) {
      sql = `${sql} LIMIT ${limit}`;
    }

    const start = Date.now();
    try {
      const result = await this.pool.query(sql);
      const duration = Date.now() - start;

      const text = [
        `[execute_query] ${result.rowCount} rows | ${duration}ms`,
        `Columns: ${result.fields.map(f => f.name).join(', ')}`,
        formatTable(result.fields.map(f => f.name), result.rows),
      ].join('\n');

      return { success: true, data: result.rows, text };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg, text: `Error: ${msg}` };
    }
  }
}

// ── explain_query ─────────────────────────────────────────────────────────────

const ExplainQueryInput = z.object({
  sql: z.string().describe('분석할 SQL 쿼리'),
  analyze: z.boolean().optional().describe('실제 실행 후 측정 여부 (기본 false)'),
});

export class ExplainQueryTool implements ITool<z.infer<typeof ExplainQueryInput>> {
  readonly name = 'explain_query';
  readonly description =
    '쿼리 실행 계획을 반환합니다. 인덱스 사용 여부, 예상 비용, Seq Scan 여부를 확인합니다.';
  readonly inputSchema = ExplainQueryInput;

  constructor(private readonly pool: PgPool) {}

  async execute(input: z.infer<typeof ExplainQueryInput>): Promise<ToolResult> {
    const analyze = input.analyze ?? false;
    const opts = analyze ? 'ANALYZE, BUFFERS, FORMAT JSON' : 'FORMAT JSON';

    try {
      const result = await this.pool.query(`EXPLAIN (${opts}) ${input.sql}`);
      const plan = result.rows[0]['QUERY PLAN'][0] as Record<string, unknown>;

      const summary = summarizePlan(plan);
      return {
        success: true,
        data: plan,
        text: `[explain_query]\n${summary}\n\nFull plan:\n${JSON.stringify(plan, null, 2).slice(0, 2000)}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg, text: `Error: ${msg}` };
    }
  }
}

// ── get_schema ────────────────────────────────────────────────────────────────

const GetSchemaInput = z.object({
  tables: z.array(z.string()).optional().describe('조회할 테이블 목록 (미지정 시 전체)'),
});

export class GetSchemaTool implements ITool<z.infer<typeof GetSchemaInput>> {
  readonly name = 'get_schema';
  readonly description =
    'DB 스키마(테이블, 컬럼, 인덱스, row count)를 반환합니다. 쿼리 작성 전 반드시 호출하세요.';
  readonly inputSchema = GetSchemaInput;

  constructor(private readonly pool: PgPool) {}

  async execute(input: z.infer<typeof GetSchemaInput>): Promise<ToolResult> {
    const filter = input.tables?.length
      ? `AND t.table_name = ANY($1)`
      : '';
    const params = input.tables?.length ? [input.tables] : [];

    try {
      const colResult = await this.pool.query(
        `SELECT t.table_name,
                json_agg(json_build_object(
                  'column', c.column_name,
                  'type', c.data_type,
                  'nullable', c.is_nullable
                ) ORDER BY c.ordinal_position) AS columns
         FROM information_schema.tables t
         JOIN information_schema.columns c
           ON t.table_name = c.table_name AND t.table_schema = c.table_schema
         WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE' ${filter}
         GROUP BY t.table_name ORDER BY t.table_name`,
        params
      );

      const rowCounts = await this.pool.query(
        `SELECT relname AS table_name, n_live_tup AS row_count
         FROM pg_stat_user_tables`
      );
      const counts = Object.fromEntries(
        rowCounts.rows.map(r => [r.table_name as string, r.row_count as number])
      );

      const lines: string[] = ['[get_schema]'];
      for (const row of colResult.rows) {
        const tbl = row.table_name as string;
        const cols = (row.columns as Array<{ column: string; type: string; nullable: string }>)
          .map(c => `  ${c.column} (${c.type}${c.nullable === 'YES' ? ', nullable' : ''})`)
          .join('\n');
        lines.push(`\n### ${tbl} — ${(counts[tbl] ?? 0).toLocaleString()} rows\n${cols}`);
      }

      return { success: true, data: colResult.rows, text: lines.join('\n') };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg, text: `Error: ${msg}` };
    }
  }
}

// ── get_table_sample ──────────────────────────────────────────────────────────

const GetTableSampleInput = z.object({
  table: z.string().describe('테이블 이름'),
  rows: z.number().optional().describe('반환할 행 수 (기본 5, 최대 20)'),
});

export class GetTableSampleTool implements ITool<z.infer<typeof GetTableSampleInput>> {
  readonly name = 'get_table_sample';
  readonly description =
    '테이블 샘플 데이터를 반환합니다. 컬럼 값의 형태와 실제 데이터를 파악할 때 사용합니다.';
  readonly inputSchema = GetTableSampleInput;

  constructor(private readonly pool: PgPool) {}

  async execute(input: z.infer<typeof GetTableSampleInput>): Promise<ToolResult> {
    const rows = Math.min(input.rows ?? 5, 20);
    // 테이블명 화이트리스트 체크 (SQL injection 방지)
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(input.table)) {
      return { success: false, error: 'Invalid table name', text: 'Error: Invalid table name' };
    }
    try {
      const result = await this.pool.query(
        `SELECT * FROM ${input.table} LIMIT $1`, [rows]
      );
      const text = [
        `[get_table_sample] ${input.table} (${result.rowCount} rows)`,
        formatTable(result.fields.map(f => f.name), result.rows),
      ].join('\n');
      return { success: true, data: result.rows, text };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg, text: `Error: ${msg}` };
    }
  }
}

// ── get_stats ─────────────────────────────────────────────────────────────────

const GetStatsInput = z.object({
  table: z.string().optional().describe('특정 테이블 (미지정 시 전체)'),
});

export class GetStatsTool implements ITool<z.infer<typeof GetStatsInput>> {
  readonly name = 'get_stats';
  readonly description =
    '테이블 크기, 인덱스 사용률 등 DB 성능 통계를 반환합니다.';
  readonly inputSchema = GetStatsInput;

  constructor(private readonly pool: PgPool) {}

  async execute(input: z.infer<typeof GetStatsInput>): Promise<ToolResult> {
    const where = input.table ? `AND relname = $1` : '';
    const params = input.table ? [input.table] : [];

    try {
      const result = await this.pool.query(
        `SELECT relname AS table_name,
                n_live_tup AS live_rows,
                seq_scan, idx_scan,
                pg_size_pretty(pg_total_relation_size(relid)) AS total_size
         FROM pg_stat_user_tables
         WHERE true ${where}
         ORDER BY n_live_tup DESC LIMIT 20`,
        params
      );

      const text = [
        '[get_stats]',
        formatTable(
          ['table', 'rows', 'seq_scan', 'idx_scan', 'size'],
          result.rows.map(r => ({
            table: r.table_name,
            rows: Number(r.live_rows).toLocaleString(),
            seq_scan: r.seq_scan,
            idx_scan: r.idx_scan,
            size: r.total_size,
          }))
        ),
      ].join('\n');

      return { success: true, data: result.rows, text };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg, text: `Error: ${msg}` };
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTable(columns: string[], rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '(no rows)';

  const widths = columns.map(c =>
    Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length))
  );
  const header = columns.map((c, i) => c.padEnd(widths[i])).join(' | ');
  const sep    = widths.map(w => '-'.repeat(w)).join('-+-');
  const body   = rows
    .slice(0, 50) // 최대 50행만 텍스트로
    .map(r => columns.map((c, i) => String(r[c] ?? '').padEnd(widths[i])).join(' | '))
    .join('\n');

  const suffix = rows.length > 50 ? `\n... (${rows.length - 50} more rows)` : '';
  return `${header}\n${sep}\n${body}${suffix}`;
}

function summarizePlan(plan: Record<string, unknown>): string {
  const node = (plan['Plan'] ?? plan) as Record<string, unknown>;
  const lines: string[] = [];
  lines.push(`Node Type: ${node['Node Type']}`);
  lines.push(`Total Cost: ${node['Total Cost']}`);
  lines.push(`Plan Rows: ${node['Plan Rows']}`);
  if (node['Index Name']) lines.push(`Index: ${node['Index Name']}`);
  if (node['Planning Time']) lines.push(`Planning Time: ${node['Planning Time']}ms`);
  if (node['Execution Time']) lines.push(`Execution Time: ${node['Execution Time']}ms`);
  return lines.join('\n');
}
