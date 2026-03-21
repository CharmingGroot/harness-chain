/**
 * Adapts harness-chain's internal ITool (text-based) to CA's ITool interface
 * so existing SQL tools can be registered in CA's Registry and used by AgentLoop.
 */
import type { ITool as CATool, ToolDescription, ToolResult as CAToolResult, JsonObject } from '@charming_groot/core';
import { RunContext } from '@charming_groot/core';
import type { ITool as HarnessTool } from './types';

export class HarnessToolAdapter implements CATool {
  readonly requiresPermission = false;

  constructor(private readonly inner: HarnessTool) {}

  get name(): string {
    return this.inner.name;
  }

  describe(): ToolDescription {
    const schema = this.inner.inputSchema as {
      properties?: Record<string, { type?: string; description?: string }>;
      required?: string[];
    };

    const parameters = Object.entries(schema.properties ?? {}).map(([name, def]) => ({
      name,
      type: (def.type as string) ?? 'string',
      description: def.description ?? '',
      required: (schema.required ?? []).includes(name),
    }));

    return {
      name: this.inner.name,
      description: this.inner.description,
      parameters,
    };
  }

  async execute(params: JsonObject, _context: RunContext): Promise<CAToolResult> {
    const result = await this.inner.execute(params);
    return {
      success: result.success,
      output: result.text,
      error: result.error,
    };
  }
}
