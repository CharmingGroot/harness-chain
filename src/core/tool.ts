import type { z } from 'zod';

/**
 * Tool — 에이전트가 호출할 수 있는 처리 도구.
 *
 * Source-bound: 특정 소스에서만 의미 있는 도구 (execute_query, get_schema 등)
 * Standalone:   소스 무관 도구 (generate_report, format_table 등)
 *
 * 서드파티 라이브러리 도구도 이 인터페이스를 구현해 등록한다.
 */
export interface ITool<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  execute(input: TInput): Promise<ToolResult<TOutput>>;
}

export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  /** 에이전트가 다음 스텝에서 읽을 텍스트 표현 */
  text: string;
}

/**
 * CA의 ToolDescription 형식으로 변환 — AgentLoop에 전달할 때 사용한다.
 */
export function toAgentTool(tool: ITool): {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
} {
  const schema = tool.inputSchema as z.ZodObject<z.ZodRawShape>;
  const shape = schema._def?.shape?.() ?? {};

  const properties: Record<string, { type: string; description: string }> = {};
  const required: string[] = [];

  for (const [key, val] of Object.entries(shape)) {
    const zodType = val as z.ZodTypeAny;
    const isOptional = zodType._def?.typeName === 'ZodOptional';
    const inner = isOptional ? zodType._def.innerType : zodType;
    properties[key] = {
      type: getZodTypeName(inner),
      description: (inner._def as { description?: string }).description ?? '',
    };
    if (!isOptional) required.push(key);
  }

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties, required },
  };
}

function getZodTypeName(zodType: z.ZodTypeAny): string {
  const name = zodType._def?.typeName as string | undefined;
  if (name === 'ZodString')  return 'string';
  if (name === 'ZodNumber')  return 'number';
  if (name === 'ZodBoolean') return 'boolean';
  if (name === 'ZodArray')   return 'array';
  return 'string';
}
