import pg from 'pg';
import type { ISource, ITool } from '../types';
import {
  ExecuteQueryTool,
  ExplainQueryTool,
  GetSchemaTool,
  GetTableSampleTool,
  GetStatsTool,
} from '../tools/sql-tools';

export interface PgSourceConfig {
  id: string;
  name: string;
  description: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export class PostgreSQLSource implements ISource {
  readonly id: string;
  readonly name: string;
  readonly type = 'postgresql';
  readonly description: string;

  private readonly pool: pg.Pool;
  private readonly _tools: ITool[];

  constructor(config: PgSourceConfig) {
    this.id = config.id;
    this.name = config.name;
    this.description = config.description;

    this.pool = new pg.Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      max: 3,
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

  getTools(): ITool[] { return this._tools; }

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

  async close(): Promise<void> { await this.pool.end(); }
}

export function createPgSandboxSource(): PostgreSQLSource {
  return new PostgreSQLSource({
    id: 'pg-sandbox',
    name: 'pg-sandbox 금융 DB',
    description: [
      '금융 도메인 PostgreSQL 데이터베이스.',
      'customers(고객정보, 10만건), transactions(거래내역, 200만건),',
      'accounts(계좌), loans(대출), investments(투자포트폴리오) 테이블 포함.',
      '금융 분석, 이상 거래 탐지, 고객 세그멘테이션, 포트폴리오 분석에 적합.',
    ].join(' '),
    host:     process.env.PG_HOST     ?? 'localhost',
    port:     Number(process.env.PG_PORT ?? 5499),
    database: process.env.PG_DB       ?? 'sandbox',
    user:     process.env.PG_USER     ?? 'sandbox',
    password: process.env.PG_PASSWORD ?? 'sandbox',
  });
}
