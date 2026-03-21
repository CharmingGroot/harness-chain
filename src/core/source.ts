import type { ITool } from './tool.js';

/**
 * Source — 에이전트가 참조할 수 있는 데이터 레퍼런스.
 *
 * NotebookLM의 "소스"처럼, 단순 정제된 데이터(스키마, 메타데이터)만 들고 있다.
 * 실제 가공은 Source에 bind된 Tool이 담당한다.
 */
export interface ISource {
  /** 고유 식별자 (예: "pg-sandbox", "sales-csv") */
  readonly id: string;
  /** 사람이 읽는 이름 */
  readonly name: string;
  /** 소스 종류 */
  readonly type: SourceType;
  /**
   * LLM이 소스 선택 판단에 사용하는 설명.
   * 어떤 데이터가 있는지, 어떤 질문에 적합한지 서술한다.
   */
  readonly description: string;
  /** 이 소스에 바인딩된 도구 목록 */
  getTools(): ITool[];
  /**
   * 연결 상태 확인. 오케스트레이터가 소스 선택 전에 호출한다.
   * 실패하면 해당 소스는 후보에서 제외된다.
   */
  ping(): Promise<boolean>;
}

export type SourceType = 'postgresql' | 'csv' | 'rest-api' | 'document';

/**
 * Source Registry — 오케스트레이터에 소스를 등록/관리한다.
 */
export class SourceRegistry {
  private readonly sources = new Map<string, ISource>();

  register(source: ISource): this {
    if (this.sources.has(source.id)) {
      throw new Error(`Source already registered: '${source.id}'`);
    }
    this.sources.set(source.id, source);
    return this;
  }

  get(id: string): ISource | undefined {
    return this.sources.get(id);
  }

  getAll(): ISource[] {
    return [...this.sources.values()];
  }

  /** 연결 가능한 소스만 반환 */
  async getAvailable(): Promise<ISource[]> {
    const results = await Promise.allSettled(
      this.getAll().map(async s => ({ source: s, ok: await s.ping() }))
    );
    return results
      .filter(r => r.status === 'fulfilled' && r.value.ok)
      .map(r => (r as PromiseFulfilledResult<{ source: ISource; ok: boolean }>).value.source);
  }
}
