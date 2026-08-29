export type CanonicalRole = "system" | "developer" | "user" | "assistant";

export type CanonicalContentBlock =
  | {
      readonly type: "text";
      readonly text: string;
      readonly sourceType: "input_text" | "output_text" | "text" | "refusal";
    }
  | {
      readonly type: "image";
      readonly imageUrl: string;
      readonly detail?: "auto" | "low" | "high" | "original";
    };

export type CanonicalConversationItem =
  | {
      readonly type: "message";
      readonly role: CanonicalRole;
      readonly content: readonly CanonicalContentBlock[];
      readonly extensions: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "tool_call";
      readonly toolType: "function" | "custom";
      readonly itemId?: string;
      readonly callId: string;
      readonly name: string;
      readonly arguments: string;
      readonly extensions: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "tool_result";
      readonly toolType: "function" | "custom";
      readonly callId: string;
      readonly output: string;
      readonly extensions: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "reasoning";
      readonly summary: readonly string[];
      readonly encryptedContent?: string;
      readonly extensions: Readonly<Record<string, unknown>>;
    };

export type CanonicalToolDefinition =
  | {
      readonly type: "function";
      readonly name: string;
      readonly description?: string;
      readonly inputSchema: Readonly<Record<string, unknown>>;
      readonly strict?: boolean;
      readonly extensions: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "custom";
      readonly name: string;
      readonly description?: string;
      readonly format?: unknown;
      readonly extensions: Readonly<Record<string, unknown>>;
    };

export interface CanonicalModelParameters {
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxOutputTokens?: number;
  readonly parallelToolCalls?: boolean;
  readonly reasoningEffort?: string;
  readonly reasoningSummary?: string;
  readonly verbosity?: string;
  readonly seed?: number;
  readonly serviceTier?: string;
  readonly store?: boolean;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface CanonicalRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly model: string;
  readonly items: readonly CanonicalConversationItem[];
  readonly tools: readonly CanonicalToolDefinition[];
  readonly toolChoice?: unknown;
  readonly parameters: CanonicalModelParameters;
  readonly stream: boolean;
  readonly extensions: Readonly<Record<string, unknown>>;
}

export const canonicalToolCallStatuses = [
  "CREATED",
  "DELIVERED",
  "EXECUTING",
  "RESOLVED",
  "FAILED",
  "CANCELLED",
] as const;

export type CanonicalToolCallStatus = (typeof canonicalToolCallStatuses)[number];

export interface CanonicalToolHistoryRecord {
  readonly toolCallId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly argumentsHash: string;
  readonly status: CanonicalToolCallStatus;
  readonly createdAt: string;
  readonly resolvedAt?: string;
  readonly resultHash?: string;
}
