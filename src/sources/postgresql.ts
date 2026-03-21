import pg from 'pg';
import type { ISource } from '../core/source.js';
import type { ITool } from '../core/tool.js';
import {
  ExecuteQueryTool,
  ExplainQueryTool,
  GetSchemaTool,
  GetTableSampleTool,
  GetStatsTool,
} from '../tools/sql-tools.js';

const { Pool } = pg;

export interface PostgreSQLSourceConfig {
  /** 고유 식별자 */
  id: string;
  /** 표시 이름 */
  name: string;
  /** LLM 소스 선택에 사용되는 설명 */
  description: string;
  /** pg 연결 설정 */
  connectionConfig: pg.PoolConfig;
}

/**
 * PostgreSQLSource — PostgreSQL DB를 소스로 등록한다.
 *
 * ping()으로 연결 상태를 확인하고,
 * getTools()로 SQL 실행/스키마 조회/통계 도구를 반환한다.
 */
export class PostgreSQLSource implements ISource {
  readonly id: string;
  readonly name: string;
  readonly type = 'postgresql' as const;
  readonly description: string;

  private readonly pool: InstanceType<typeof Pool>;
  private readonly _tools: ITool[];

  constructor(config: PostgreSQLSourceConfig) {
    this.id          = config.id;
    this.name        = config.name;
    this.description = config.description;

    this.pool = new Pool({
      ...config.connectionConfig,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    this._tools = [
      new GetSchemaTool(this.pool),
      new ExecuteQueryTool(this.pool),
      new ExplainQueryTool(this.pool),
      new GetTableSampleTool(this.pool),
      new GetStatsTool(this.pool),
    ];
  }

  getTools(): ITool[] {
    return this._tools;
  }

  async ping(): Promise<boolean> {
    try {
      const client = await this.pool.connect();
      await client.query('SELECT 1');
      client.release();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ── Factory helpers ────────────────────────────────────────────────────────────

/**
 * 환경 변수에서 PostgreSQL 소스를 생성한다.
 *
 * 필요 환경 변수: PG_HOST, PG_PORT, PG_DB, PG_USER, PG_PASSWORD
 */
export function createPostgreSQLSourceFromEnv(
  id: string,
  name: string,
  description: string,
  prefix = 'PG'
): PostgreSQLSource {
  const env = process.env;
  return new PostgreSQLSource({
    id,
    name,
    description,
    connectionConfig: {
      host:     env[`${prefix}_HOST`]     ?? 'localhost',
      port:     Number(env[`${prefix}_PORT`] ?? 5432),
      database: env[`${prefix}_DB`]       ?? 'sandbox',
      user:     env[`${prefix}_USER`]     ?? 'sandbox',
      password: env[`${prefix}_PASSWORD`] ?? 'sandbox',
    },
  });
}
