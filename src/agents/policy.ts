export type CliProvider = "opencode" | "agy";
export type CliPhase = "turn" | "signoff" | "plan";

export interface CliFailureDetails {
  message?: string;
  code?: number | string;
  signal?: string;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (retry: number, delayMs: number, error: unknown) => void;
}

const DEFAULT_TIMEOUTS: Record<CliPhase, number> = {
  turn: 4 * 60 * 1000,
  signoff: 3 * 60 * 1000,
  plan: 5 * 60 * 1000,
};

const CURRENT_MCP_SERVERS = ["gitnexus", "chrome-devtools", "angular-cli", "gemini-browser", "debate-room"] as const;

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 60 * 60 * 1000) {
    throw new Error(`${name} debe ser un entero entre 1 y 3600000 ms.`);
  }
  return parsed;
}

function nonNegativeInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 5) {
    throw new Error(`${name} debe ser un entero entre 0 y 5.`);
  }
  return parsed;
}

export function resolveCliTimeout(provider: CliProvider, phase: CliPhase, env: NodeJS.ProcessEnv = process.env): number {
  const providerName = provider.toUpperCase();
  const phaseName = phase.toUpperCase();
  const fallback = DEFAULT_TIMEOUTS[phase];
  return positiveInteger(
    env[`DEBATE_TIMEOUT_${providerName}_${phaseName}_MS`]
      ?? env[`DEBATE_TIMEOUT_${providerName}_MS`]
      ?? env.DEBATE_TIMEOUT_MS,
    fallback,
    `DEBATE_TIMEOUT_${providerName}_${phaseName}_MS`,
  );
}

export function resolveRetryPolicy(env: NodeJS.ProcessEnv = process.env): Required<Pick<RetryOptions, "maxRetries" | "baseDelayMs" | "maxDelayMs">> {
  return {
    maxRetries: nonNegativeInteger(env.DEBATE_MAX_RETRIES, 2, "DEBATE_MAX_RETRIES"),
    baseDelayMs: positiveInteger(env.DEBATE_RETRY_BASE_MS, 1000, "DEBATE_RETRY_BASE_MS"),
    maxDelayMs: positiveInteger(env.DEBATE_RETRY_MAX_MS, 8000, "DEBATE_RETRY_MAX_MS"),
  };
}

export function createOpenCodeChildEnvironment(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  let existing: Record<string, unknown> = {};
  const content = parent.OPENCODE_CONFIG_CONTENT;
  if (content) {
    try {
      existing = objectValue(JSON.parse(content));
    } catch (error) {
      throw new Error(`OPENCODE_CONFIG_CONTENT no contiene JSON válido: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const existingMcp = objectValue(existing.mcp);
  const mcp: Record<string, unknown> = { ...existingMcp };
  for (const [serverName, definition] of Object.entries(existingMcp)) {
    mcp[serverName] = { ...objectValue(definition), enabled: false };
  }
  for (const serverName of CURRENT_MCP_SERVERS) {
    mcp[serverName] = { ...objectValue(existingMcp[serverName]), enabled: false };
  }

  const tools = { ...objectValue(existing.tools), "*": false };
  const isolatedConfig = { ...existing, mcp, tools };
  return { ...parent, OPENCODE_CONFIG_CONTENT: JSON.stringify(isolatedConfig) };
}

export function isQuotaFailure(error: unknown): boolean {
  const details = error && typeof error === "object" ? error as CliFailureDetails : {};
  const text = `${error instanceof Error ? error.message : details.message ?? String(error)}\n${details.stdout ?? ""}\n${details.stderr ?? ""}`;
  return /RESOURCE_EXHAUSTED|quota\s+(?:reached|exhausted|exceeded)|insufficient\s+(?:credits?|balance)|(?:resets?|reset)\s+in\s+\d/i.test(text);
}

export function isRetryableCliFailure(error: unknown): boolean {
  if (isQuotaFailure(error)) return false;
  const details = error && typeof error === "object" ? error as CliFailureDetails : {};
  const text = `${error instanceof Error ? error.message : details.message ?? String(error)}\n${details.stdout ?? ""}\n${details.stderr ?? ""}`;
  if (details.timedOut) return true;
  if (typeof details.code === "string" && /^(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE)$/i.test(details.code)) return true;
  if (/Retry-After|retry_after|retryable["']?\s*:\s*true|temporarily unavailable|endpoint is unavailable|connection reset|socket hang up/i.test(text)) return true;
  return false;
}

const sleepDefault = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withTransientRetries<T>(operation: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const defaults = resolveRetryPolicy();
  const maxRetries = options.maxRetries ?? defaults.maxRetries;
  const baseDelayMs = options.baseDelayMs ?? defaults.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? defaults.maxDelayMs;
  const sleep = options.sleep ?? sleepDefault;

  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      const retriesUsed = attempt - 1;
      if (retriesUsed >= maxRetries || !isRetryableCliFailure(error)) throw error;
      const delayMs = Math.min(baseDelayMs * 2 ** retriesUsed, maxDelayMs);
      options.onRetry?.(retriesUsed + 1, delayMs, error);
      await sleep(delayMs);
    }
  }
}
