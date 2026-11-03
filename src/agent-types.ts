export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
  rawArgs: string;
}

export interface AssistantTurn {
  role: "assistant";
  text: string;
  toolCalls: ToolCall[];
  rawItems?: unknown[];
}

// rawItems: adapter-specific raw reply items to echo verbatim on the next turn
// (OpenAI Responses reasoning items must be passed back with tool outputs).

export interface ToolResultTurn {
  role: "tool";
  id: string;
  name: string;
  output: string;
  isError?: boolean;
}

export interface UserNoteTurn {
  role: "user";
  text: string;
}

export type Turn = AssistantTurn | ToolResultTurn | UserNoteTurn;

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface Conversation {
  system: string;
  user: string;
  turns?: Turn[];
  tools?: ToolDef[];
}

/** Seconds held back from the agent budget so a final model call can still start. */
export const AGENT_RESERVE_SECONDS = 10;

export const AGENT_LIMITS = {
  maxCallsPerTurn: 4,
  resultBytes: 32768,
  totalBytes: 131072,
  linkedRepos: 3,
  cloneMs: 60000,
  cloneMaxBytes: 209715200,
};
