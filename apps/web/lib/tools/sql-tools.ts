import type { Pool } from 'pg';
import type { ITool, ToolResult } from '../types';

// ── execute_query ──────────────────────────────────────────────────────────────

export class ExecuteQueryTool implements ITool {
  readonly name = 'execute_query';
  readonly description = 'SQL 쿼리를 실행하고 결과를 반환합니다. SELECT 쿼리에 자동으로 LIMIT을 적용합니다.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      sql: { type: 'string', description: '실행할 SQL 쿼리' },
      limit: { type: 'number', description: '최대 반환 행 수 (기본 200, 최대 2000)' },
    },
    required: ['sql'],
  };

  constructor(private readonly pool: Pool) {}

  async execute(input: unknown): Promise<ToolResult> {
    const { sql: rawSql, limit: rawLimit } = input as { sql: string; limit?: number };
    const limit = Math.min(rawLimit ?? 200, 2000);
    let sql = rawSql.trim().replace(/;$/, '');
    if (/^SELECT/i.test(sql) && !/LIMIT\s+\d+/i.test(sql)) {
      sql = `${sql} LIMIT ${limit}`;
    }
    try {
      const result = await this.pool.query(sql);
      const text = [
        `[execute_query] ${result.rowCount} rows`,
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

export class ExplainQueryTool implements ITool {
  readonly name = 'explain_query';
  readonly description = '쿼리 실행 계획을 반환합니다.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      sql: { type: 'string', description: '분석할 SQL 쿼리' },
      analyze: { type: 'boolean', description: '실제 실행 후 측정 여부 (기본 false)' },
    },
    required: ['sql'],
  };

  constructor(private readonly pool: Pool) {}

  async execute(input: unknown): Promise<ToolResult> {
    const { sql, analyze = false } = input as { sql: string; analyze?: boolean };
    const opts = analyze ? 'ANALYZE, BUFFERS, FORMAT JSON' : 'FORMAT JSON';
    try {
      const result = await this.pool.query(`EXPLAIN (${opts}) ${sql}`);
      const plan = result.rows[0]['QUERY PLAN'][0] as Record<string, unknown>;
      const node = (plan['Plan'] ?? plan) as Record<string, unknown>;
      const summary = [
        `Node Type: ${node['Node Type']}`,
        `Total Cost: ${node['Total Cost']}`,
        `Plan Rows: ${node['Plan Rows']}`,
        node['Index Name'] ? `Index: ${node['Index Name']}` : null,
      ].filter(Boolean).join('\n');
      return { success: true, data: plan, text: `[explain_query]\n${summary}\n\n${JSON.stringify(plan, null, 2).slice(0, 1500)}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg, text: `Error: ${msg}` };
    }
  }
}

// ── get_schema ────────────────────────────────────────────────────────────────

export class GetSchemaTool implements ITool {
  readonly name = 'get_schema';
  readonly description = 'DB 스키마(테이블, 컬럼, 인덱스, row count)를 반환합니다. 쿼리 작성 전 반드시 호출하세요.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      tables: { type: 'array', items: { type: 'string' }, description: '조회할 테이블 목록 (미지정 시 전체)' },
    },
    required: [],
  };

  constructor(private readonly pool: Pool) {}

  async execute(input: unknown): Promise<ToolResult> {
    const { tables } = (input ?? {}) as { tables?: string[] };
    const filter = tables?.length ? `AND t.table_name = ANY($1)` : '';
    const params = tables?.length ? [tables] : [];

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
        `SELECT relname AS table_name, n_live_tup AS row_count FROM pg_stat_user_tables`
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

export class GetTableSampleTool implements ITool {
  readonly name = 'get_table_sample';
  readonly description = '테이블 샘플 데이터를 반환합니다.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      table: { type: 'string', description: '테이블 이름' },
      rows: { type: 'number', description: '반환할 행 수 (기본 5, 최대 20)' },
    },
    required: ['table'],
  };

  constructor(private readonly pool: Pool) {}

  async execute(input: unknown): Promise<ToolResult> {
    const { table, rows: rowCount = 5 } = input as { table: string; rows?: number };
    const rows = Math.min(rowCount, 20);
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
      return { success: false, error: 'Invalid table name', text: 'Error: Invalid table name' };
    }
    try {
      const result = await this.pool.query(`SELECT * FROM ${table} LIMIT $1`, [rows]);
      const text = [`[get_table_sample] ${table}`, formatTable(result.fields.map(f => f.name), result.rows)].join('\n');
      return { success: true, data: result.rows, text };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg, text: `Error: ${msg}` };
    }
  }
}

// ── get_stats ─────────────────────────────────────────────────────────────────

export class GetStatsTool implements ITool {
  readonly name = 'get_stats';
  readonly description = '테이블 크기, 인덱스 사용률 등 DB 성능 통계를 반환합니다.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      table: { type: 'string', description: '특정 테이블 (미지정 시 전체)' },
    },
    required: [],
  };

  constructor(private readonly pool: Pool) {}

  async execute(input: unknown): Promise<ToolResult> {
    const { table } = (input ?? {}) as { table?: string };
    const where = table ? `AND relname = $1` : '';
    const params = table ? [table] : [];
    try {
      const result = await this.pool.query(
        `SELECT relname AS table_name, n_live_tup AS live_rows, seq_scan, idx_scan,
                pg_size_pretty(pg_total_relation_size(relid)) AS total_size
         FROM pg_stat_user_tables WHERE true ${where} ORDER BY n_live_tup DESC LIMIT 20`,
        params
      );
      const text = ['[get_stats]', formatTable(
        ['table', 'rows', 'seq_scan', 'idx_scan', 'size'],
        result.rows.map(r => ({
          table: r.table_name,
          rows: Number(r.live_rows).toLocaleString(),
          seq_scan: r.seq_scan,
          idx_scan: r.idx_scan,
          size: r.total_size,
        }))
      )].join('\n');
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
  const sep = widths.map(w => '-'.repeat(w)).join('-+-');
  const body = rows.slice(0, 30)
    .map(r => columns.map((c, i) => String(r[c] ?? '').padEnd(widths[i])).join(' | '))
    .join('\n');
  const suffix = rows.length > 30 ? `\n... (${rows.length - 30} more rows)` : '';
  return `${header}\n${sep}\n${body}${suffix}`;
}
