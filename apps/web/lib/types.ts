export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  text: string;
}

export interface ITool {
  readonly name: string;
  readonly description: string;
  execute(input: unknown): Promise<ToolResult>;
  inputSchema: Record<string, unknown>;
}

export interface ISource {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly description: string;
  getTools(): ITool[];
  ping(): Promise<boolean>;
}

export interface RunResult {
  report: string;
  sourcesUsed: string[];
  toolCallCount: number;
  iterations: number;
}

// SSE event types
export type AnalyzeEvent =
  | { type: 'source_check'; message: string }
  | { type: 'source_selected'; sources: string[] }
  | { type: 'tool_call'; tool: string; input: string }
  | { type: 'tool_result'; tool: string; success: boolean; preview: string }
  | { type: 'thinking'; text: string }
  | { type: 'report'; report: string; meta: { sourcesUsed: string[]; toolCallCount: number; iterations: number } }
  | { type: 'error'; message: string };
