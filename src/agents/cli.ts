import { spawn } from "node:child_process";
import path from "node:path";
import { resolveCliTimeout, resolveRetryPolicy, withTransientRetries, createOpenCodeChildEnvironment, type CliPhase, type CliProvider } from "./policy.js";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const appData = process.env.APPDATA ?? "";
const localAppData = process.env.LOCALAPPDATA ?? "";
const MAX_OUTPUT = 12 * 1024 * 1024;

function executable(envName: string, windowsPath: string, fallback: string): string {
  return process.env[envName] || (process.platform === "win32" ? windowsPath : fallback);
}

const opencodeBin = executable("OPENCODE_BIN", path.join(appData, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe"), "opencode");
const agyBin = executable("AGY_BIN", path.join(localAppData, "agy", "bin", "agy.exe"), "agy");

export interface AgentSession { id?: string; conversationId?: string }
export interface CliRunOptions {
  model?: string;
  phase?: CliPhase;
  timeoutMs?: number;
  maxRetries?: number;
  env?: NodeJS.ProcessEnv;
  onRetry?: (retry: number, delayMs: number, error: unknown) => void;
  onOutput?: (stdout: string, stderr: string, attempt: number) => void;
}

interface CliExecutionDetails {
  code?: number | string;
  signal?: string;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
}

class CliExecutionError extends Error implements CliExecutionDetails {
  readonly code?: number | string;
  readonly signal?: string;
  readonly timedOut?: boolean;
  readonly stdout?: string;
  readonly stderr?: string;

  constructor(message: string, details: CliExecutionDetails = {}) {
    super(message);
    this.name = "CliExecutionError";
    Object.assign(this, details);
  }
}

function timeoutFor(provider: CliProvider, phase: CliPhase, options: CliRunOptions): number {
  return options.timeoutMs ?? resolveCliTimeout(provider, phase);
}

export function runCliProcessOnce(
  file: string,
  args: string[],
  label: string,
  model: string,
  provider: CliProvider,
  phase: CliPhase,
  attempt: number,
  options: CliRunOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const timeoutMs = timeoutFor(provider, phase, options);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child: ReturnType<typeof spawn>;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        options.onOutput?.(stdout, stderr, attempt);
      } catch (outputError) {
        error = new Error(`No pude guardar la salida de ${label}: ${outputError instanceof Error ? outputError.message : String(outputError)}`);
      }
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };

    try {
      child = spawn(file, args, {
        cwd: projectRoot,
        env: provider === "opencode" ? createOpenCodeChildEnvironment(options.env ?? process.env) : options.env ?? process.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new CliExecutionError(`${label} no pudo iniciarse: ${error instanceof Error ? error.message : String(error)}`, { code: "SPAWN_ERROR" }));
      return;
    }

    const timer = setTimeout(() => {
      child.kill();
      finish(new CliExecutionError(`${label} excedió el timeout de ${timeoutMs}ms en la fase ${phase} (modelo ${model}).`, {
        code: "ETIMEDOUT",
        timedOut: true,
        stdout,
        stderr,
      }));
    }, timeoutMs);

    const childStdout = child.stdout;
    const childStderr = child.stderr;
    if (!childStdout || !childStderr) {
      child.kill();
      finish(new CliExecutionError(`${label} no abrió los pipes de salida.`));
      return;
    }
    childStdout.setEncoding("utf8");
    childStderr.setEncoding("utf8");
    const append = (target: "stdout" | "stderr", chunk: string) => {
      if (target === "stdout") stdout += chunk;
      else stderr += chunk;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_OUTPUT) {
        child.kill();
        finish(new CliExecutionError(`${label} excedió el límite de salida de ${MAX_OUTPUT} bytes.`, { code: "OUTPUT_LIMIT", stdout, stderr }));
      }
    };
    childStdout.on("data", (chunk: string) => append("stdout", chunk));
    childStderr.on("data", (chunk: string) => append("stderr", chunk));
    child.once("error", (error) => finish(new CliExecutionError(`${label} no pudo iniciarse: ${error.message}`, { code: (error as NodeJS.ErrnoException).code ?? "SPAWN_ERROR", stdout, stderr })));
    child.once("close", (code, signal) => {
      if (code !== 0) finish(new CliExecutionError(`${label} terminó con código ${code ?? signal ?? "desconocido"}.`, { code: code ?? undefined, signal: signal ?? undefined, stdout, stderr }));
      else finish();
    });
  });
}

async function runProcess(
  file: string,
  args: string[],
  label: string,
  model: string,
  provider: CliProvider,
  options: CliRunOptions,
  parse: (output: { stdout: string; stderr: string }) => { text: string; session: AgentSession },
): Promise<{ text: string; session: AgentSession }> {
  const phase = options.phase ?? "turn";
  const retryPolicy = resolveRetryPolicy();
  return withTransientRetries(async (attempt) => {
    const output = await runCliProcessOnce(file, args, label, model, provider, phase, attempt, options);
    return parse(output);
  }, {
    ...retryPolicy,
    maxRetries: options.maxRetries ?? retryPolicy.maxRetries,
    onRetry: options.onRetry,
  });
}

function extractOpenCodeText(stdout: string, currentSessionId?: string): { text: string; sessionId?: string } {
  let text = "";
  let sessionId = currentSessionId;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (typeof event.sessionID === "string") sessionId = event.sessionID;
      if (typeof event.sessionId === "string") sessionId = event.sessionId;
      const part = event.part as Record<string, unknown> | undefined;
      if (typeof part?.text === "string") text += part.text;
      else if (typeof event.text === "string") text += event.text;
      const message = event.message as Record<string, unknown> | undefined;
      if (typeof message?.text === "string") text += message.text;
    } catch {
      text += `${line}\n`;
    }
  }
  return { text: text.trim(), sessionId };
}

export async function runOpenCode(prompt: string, session: AgentSession, title: string, options: CliRunOptions = {}): Promise<{ text: string; session: AgentSession }> {
  const model = options.model || process.env.OPENCODE_MODEL || "openai/gpt-6-luna-fast";
  const args = ["run", "--format", "json", "--agent", "plan", "--dir", projectRoot, "--model", model];
  if (session.id) args.push("--session", session.id);
  else args.push("--title", title);
  args.push(prompt);
  return runProcess(opencodeBin, args, "OpenCode CLI", model, "opencode", options, ({ stdout, stderr }) => {
    const result = extractOpenCodeText(stdout, session.id);
    if (!result.text) throw new CliExecutionError(`OpenCode no devolvió texto parseable.\nstderr:\n${stderr}\nstdout:\n${stdout}`, { stdout, stderr, code: "EMPTY_RESPONSE" });
    return { text: result.text, session: { ...session, id: result.sessionId } };
  });
}

function printTimeout(timeoutMs: number): string {
  return `${Math.max(1, Math.ceil(timeoutMs / 60_000))}m`;
}

export async function runAntigravity(prompt: string, session: AgentSession, options: CliRunOptions = {}): Promise<{ text: string; session: AgentSession }> {
  const model = options.model || process.env.AGY_MODEL;
  const phase = options.phase ?? "turn";
  const timeoutMs = timeoutFor("agy", phase, options);
  const args = ["-p", prompt, "--output-format", "json", "--mode", "plan", "--print-timeout", printTimeout(timeoutMs)];
  if (session.conversationId) args.push("--conversation", session.conversationId);
  if (model) args.push("--model", model);
  if (process.env.AGY_EFFORT) args.push("--effort", process.env.AGY_EFFORT);
  return runProcess(agyBin, args, "Antigravity CLI", model ?? "configurado en agy", "agy", options, ({ stdout, stderr }) => {
    let responseText = stdout.trim();
    let conversationId = session.conversationId;
    try {
      const envelope = JSON.parse(responseText) as {
        response?: unknown;
        conversation_id?: unknown;
        conversationId?: unknown;
        status?: unknown;
        error?: unknown;
        error_code?: unknown;
        retryable?: unknown;
      };
      if (typeof envelope.response === "string") responseText = envelope.response;
      if (typeof envelope.conversation_id === "string") conversationId = envelope.conversation_id;
      if (typeof envelope.conversationId === "string") conversationId = envelope.conversationId;
      if (envelope.status === "ERROR") {
        const retryableText = envelope.retryable === true ? " retryable:true" : "";
        throw new CliExecutionError(`Antigravity devolvió status=ERROR, error_code=${String(envelope.error_code ?? "desconocido")}: ${String(envelope.error ?? "sin detalle")}${retryableText}`, {
          code: typeof envelope.error_code === "string" || typeof envelope.error_code === "number" ? envelope.error_code : "AGY_ERROR",
          stdout,
          stderr,
        });
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (!responseText) throw new CliExecutionError(`Antigravity no devolvió texto.\nstdout:\n${stdout || "vacío"}\nstderr:\n${stderr || "vacío"}`, { stdout, stderr, code: "EMPTY_RESPONSE" });
    return { text: responseText, session: { ...session, conversationId } };
  });
}

export function workspacePath(): string { return projectRoot; }
