import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { runAntigravity, runOpenCode } from "./agents/cli.js";
import type { CliRunOptions, CliTokenUsage } from "./agents/cli.js";
import { closeRoom, createRoom, getDataRoot, getRoom, postTurn, setPlan, transcriptPath } from "./room.js";
import { DebateTurnSchema, FinalPlanSchema, type DebateTurn, type FinalPlan, type Seat } from "./schema.js";
import { createProposalRevisionId } from "./proposal.js";
import { compactRoomHistory } from "./prompt.js";

const turnSchemaText = `{"stance":"string","critique":["string"],"agree":false,"open_points":["string"],"proposal":"string","acceptedRevisionId":"sha256 hex or null"}`;
const planSchemaText = `{"title":"string","summary":"string","decisions":["string"],"steps":["string"],"risks":["string"],"dissent":["string"]}`;
let runLogPath: string | undefined;
let activeRoomId: string | undefined;
let activeEngine: "both" | "agy" | undefined;
let activeModels: Record<string, string | undefined> = {};
const tokenMetrics = {
  promptAttempts: 0,
  promptBytes: 0,
  legacyHistoryBytes: 0,
  compactHistoryBytes: 0,
  agyUsageReports: 0,
  agyUsage: {} as CliTokenUsage,
  agyUsageByCall: [] as Array<{ phase: string; model?: string; usage: CliTokenUsage }>,
};

function recordPromptAttempt(prompt: string, legacyHistory?: string, compactHistory?: string): void {
  tokenMetrics.promptAttempts++;
  tokenMetrics.promptBytes += Buffer.byteLength(prompt, "utf8");
  if (legacyHistory !== undefined && compactHistory !== undefined) {
    tokenMetrics.legacyHistoryBytes += Buffer.byteLength(legacyHistory, "utf8");
    tokenMetrics.compactHistoryBytes += Buffer.byteLength(compactHistory, "utf8");
  }
}

function recordAgyUsage(usage: CliTokenUsage, phase: string, model?: string): void {
  tokenMetrics.agyUsageReports++;
  tokenMetrics.agyUsageByCall.push({ phase, model, usage });
  for (const key of [
    "input_tokens",
    "output_tokens",
    "thinking_tokens",
    "cache_read_tokens",
    "total_tokens",
  ] as const) {
    const count = usage[key];
    if (count !== undefined) tokenMetrics.agyUsage[key] = (tokenMetrics.agyUsage[key] ?? 0) + count;
  }
}

function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  if (runLogPath) appendFileSync(runLogPath, `${line}\n`, "utf8");
}

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function parseStructured<T>(text: string, validate: (value: unknown) => T, label: string): T {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error(`${label} no devolvió JSON. Respuesta: ${text.slice(0, 500)}`);
  try {
    return validate(JSON.parse(text.slice(first, last + 1)));
  } catch (error) {
    throw new Error(
      `${label} devolvió JSON inválido: ${error instanceof Error ? error.message : String(error)}\n${text.slice(0, 700)}`,
    );
  }
}

function validateTurn(value: unknown): DebateTurn {
  return DebateTurnSchema.parse(value);
}
function validatePlan(value: unknown): FinalPlan {
  return FinalPlanSchema.parse(value);
}

function captureCliOutput(roomFolder: string, prefix: string): NonNullable<CliRunOptions["onOutput"]> {
  return (stdout: string, stderr: string, attempt: number) => {
    const attemptPrefix = `${prefix}.attempt-${attempt}`;
    writeFileSync(path.join(roomFolder, `${attemptPrefix}.stdout.txt`), stdout, "utf8");
    writeFileSync(path.join(roomFolder, `${attemptPrefix}.stderr.txt`), stderr, "utf8");
  };
}

async function withHeartbeat<T>(label: string, work: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    log(`Sigo esperando a ${label}: ${elapsed}s.`);
  }, 15_000);
  timer.unref();
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

interface ActiveProposal {
  revisionId: string;
  text: string;
}

function turnPrompt(
  topic: string,
  side: Seat,
  history: string,
  opening: boolean,
  activeProposal?: ActiveProposal,
): string {
  const role =
    side === "opencode"
      ? "Eres el proponente: formula una solución clara y defiéndela con argumentos verificables. También debes señalar debilidades propias honestamente."
      : "Eres el revisor crítico: desafía supuestos, detecta riesgos y propone mejoras concretas. No discrepes por deporte; acepta una solución si los puntos quedaron resueltos.";
  return [
    "Participas en un debate estructurado entre dos agentes para acordar un plan de trabajo.",
    "El debate lo orquesta un programa externo. No llames herramientas, no leas ni ejecutes comandos y no uses ninguna herramienta room_*. Devuelve únicamente el JSON solicitado; no publiques ni te unas a la sala.",
    "Responde SOLO un objeto JSON válido, sin markdown ni texto alrededor, con esta forma exacta:",
    turnSchemaText,
    `Tu asiento: ${side}. ${role}`,
    `Tema: ${topic}`,
    opening
      ? "Es tu intervención inicial: propón una dirección y enumera incógnitas importantes."
      : "Responde directamente a la última intervención. Resuelve objeciones concretas; cambia de postura si el argumento rival es mejor.",
    activeProposal
      ? `Propuesta vigente (${activeProposal.revisionId}):\n${activeProposal.text}\n\nSi la aceptas sin cambios, devuelve agree=true, acceptedRevisionId=${activeProposal.revisionId} y copia exactamente la propuesta vigente en proposal. Si la cambias o discrepas, devuelve agree=false y acceptedRevisionId=null; esa nueva propuesta iniciará otra revisión.`
      : "Todavía no existe una propuesta vigente que aceptar; inicia con agree=false y acceptedRevisionId=null.",
    "Historial de la sala (JSON):",
    history,
    "Pon agree=true únicamente si aceptas exactamente la revisión vigente identificada arriba y open_points está vacío. En cualquier otro caso usa agree=false y acceptedRevisionId=null; proposal debe ser la propuesta completa.",
  ].join("\n\n");
}

function enforceRevisionAcceptance(
  turn: DebateTurn,
  activeProposal: ActiveProposal | undefined,
  label: string,
): DebateTurn {
  if (!turn.agree) return { ...turn, acceptedRevisionId: null };
  const matches =
    activeProposal &&
    turn.acceptedRevisionId === activeProposal.revisionId &&
    createProposalRevisionId(turn.proposal) === activeProposal.revisionId &&
    turn.open_points.length === 0;
  if (matches) return turn;
  const reason = activeProposal
    ? `La aceptación no coincide con la revisión vigente ${activeProposal.revisionId}; vuelve a evaluar o copia exactamente esa revisión.`
    : "No hay una revisión previa que puedas aceptar en este turno.";
  log(`${label}: acuerdo rechazado porque no confirmó la revisión vigente.`);
  return { ...turn, agree: false, acceptedRevisionId: null, open_points: [...turn.open_points, reason] };
}

async function askSeat(
  topic: string,
  side: Seat,
  history: string,
  legacyHistory: string,
  opening: boolean,
  activeProposal: ActiveProposal | undefined,
  engine: "both" | "agy",
  proposerModel: string | undefined,
  criticModel: string | undefined,
  roomFolder: string,
  round: number,
  sessions: {
    opencode: { id?: string };
    antigravity: { conversationId?: string };
    proposer: { conversationId?: string };
  },
) {
  const prompt = turnPrompt(topic, side, history, opening, activeProposal);
  if (side === "opencode" && engine === "both") {
    log(`Ronda activa: solicitando intervención a OpenCode${sessions.opencode.id ? " (continúa sesión)" : ""}.`);
    const response = await withHeartbeat("OpenCode", () =>
      runOpenCode(prompt, sessions.opencode, `Debate ${topic.slice(0, 45)}`, {
        phase: "turn",
        onAttempt: () => recordPromptAttempt(prompt, legacyHistory, history),
        onRetry: (retry, delay, error) =>
          log(`OpenCode: reintento ${retry} en ${delay}ms tras error transitorio: ${String(error)}`),
        onOutput: captureCliOutput(roomFolder, `round-${round}-opencode`),
      }),
    );
    Object.assign(sessions.opencode, response.session);
    return enforceRevisionAcceptance(
      parseStructured(response.text, validateTurn, "OpenCode"),
      activeProposal,
      "OpenCode",
    );
  }
  const proposer = side === "opencode";
  const session = proposer ? sessions.proposer : sessions.antigravity;
  const model = proposer ? proposerModel : criticModel;
  const label = proposer ? "Antigravity proponente" : "Antigravity crítico";
  log(
    `Ronda activa: solicitando intervención a ${label}${session.conversationId ? " (continúa conversación)" : ""}${model ? ` [${model}]` : ""}.`,
  );
  const response = await withHeartbeat(label, () =>
    runAntigravity(prompt, session, {
      model,
      phase: "turn",
      onAttempt: () => recordPromptAttempt(prompt, legacyHistory, history),
      onUsage: (usage) => recordAgyUsage(usage, "turn", model),
      onRetry: (retry, delay, error) =>
        log(`${label}: reintento ${retry} en ${delay}ms tras error transitorio: ${String(error)}`),
      onOutput: captureCliOutput(roomFolder, `round-${round}-${proposer ? "proposer" : "critic"}`),
    }),
  );
  Object.assign(session, response.session);
  return enforceRevisionAcceptance(parseStructured(response.text, validateTurn, label), activeProposal, label);
}

function signoffPrompt(topic: string, planText: string, roomId: string, revisionId: string): string {
  return [
    "Revisa y firma el plan final persistido como signatario de la sala de debate.",
    "La aplicación registra tu firma externamente. No llames herramientas ni uses room_*; responde solo con JSON.",
    `Tema: ${topic}`,
    `Sala: ${roomId}`,
    `Revisión exacta: ${revisionId}`,
    "Si aceptas exactamente el texto almacenado, responde agree=true, acceptedRevisionId con ese ID, open_points=[] y copia el plan en proposal sin modificarlo. Si no, agree=false, acceptedRevisionId=null y enumera solo bloqueos reales.",
    "Plan:",
    planText,
    "Devuelve SOLO JSON válido con esta forma:",
    turnSchemaText,
  ].join("\n\n");
}

async function producePlan(
  topic: string,
  roomId: string,
  history: string,
  legacyHistory: string,
  agreed: boolean,
  proposedFallback: string,
  engine: "both" | "agy",
  criticModel: string | undefined,
  roomFolder: string,
): Promise<FinalPlan> {
  const prompt = [
    "Sintetiza un plan de trabajo a partir del debate. No inventes acuerdos: si no hubo consenso, conserva las objeciones en dissent.",
    "No uses herramientas ni leas o ejecutes comandos; entrega únicamente el JSON del plan.",
    `Tema: ${topic}`,
    `Consenso firmado: ${agreed}`,
    "Transcripción en JSON:",
    history,
    "Devuelve SOLO JSON válido, sin markdown, con esta forma:",
    planSchemaText,
    `Propuesta de respaldo: ${proposedFallback}`,
  ].join("\n\n");
  try {
    const { text } =
      engine === "agy"
        ? await withHeartbeat("Antigravity para sintetizar el plan", () =>
            runAntigravity(
              prompt,
              {},
              {
                model: criticModel,
                phase: "plan",
                onAttempt: () => recordPromptAttempt(prompt, legacyHistory, history),
                onUsage: (usage) => recordAgyUsage(usage, "plan", criticModel),
                onRetry: (retry, delay, error) =>
                  log(`Antigravity plan: reintento ${retry} en ${delay}ms: ${String(error)}`),
                onOutput: captureCliOutput(roomFolder, "final-plan"),
              },
            ),
          )
        : await withHeartbeat("OpenCode para sintetizar el plan", () =>
            runOpenCode(prompt, {}, `Plan final debate ${topic.slice(0, 40)}`, {
              phase: "plan",
              onAttempt: () => recordPromptAttempt(prompt, legacyHistory, history),
              onRetry: (retry, delay, error) =>
                log(`OpenCode plan: reintento ${retry} en ${delay}ms: ${String(error)}`),
              onOutput: captureCliOutput(roomFolder, "final-plan"),
            }),
          );
    return parseStructured(
      text,
      validatePlan,
      `${engine === "agy" ? "Antigravity" : "OpenCode"} al sintetizar el plan`,
    );
  } catch (error) {
    log(
      `No pude sintetizar el plan con ${engine === "agy" ? "Antigravity" : "OpenCode"} (${String(error)}); guardaré plan de respaldo.`,
    );
    return {
      title: topic,
      summary: proposedFallback || "Debate terminado sin resumen generado.",
      decisions: [],
      steps: [],
      risks: [],
      dissent: agreed ? [] : ["No se alcanzó consenso en el límite de rondas."],
    };
  }
}

async function main() {
  let topic = arg("--topic")?.trim();
  const topicFile = arg("--topic-file");
  if (!topic && topicFile) {
    topic = (await readFile(path.resolve(topicFile), "utf8")).replace(/^\uFEFF/, "").trim();
    await rm(path.resolve(topicFile), { force: true });
  }
  if (!topic || process.argv.includes("--help")) {
    console.log('Uso: npm run debate -- --topic "Tema" [--topic-file tema.txt] [--rounds 6] [--log-file ruta.log]');
    process.exit(topic ? 0 : 2);
  }
  const rounds = Number(arg("--rounds", "6"));
  const engine = arg("--engine", "agy");
  if (engine !== "both" && engine !== "agy") throw new Error('--engine debe ser "both" o "agy".');
  const proposerModel = arg(
    "--proposer-model",
    process.env.AGY_PROPOSER_MODEL ?? (engine === "agy" ? "gemini-3.8-flash-low" : undefined),
  );
  const criticModel = arg(
    "--critic-model",
    process.env.AGY_CRITIC_MODEL ?? process.env.AGY_MODEL ?? "gemini-3.8-flash-low",
  );
  activeEngine = engine;
  activeModels =
    engine === "agy"
      ? { proposer: proposerModel, critic: criticModel }
      : { opencode: process.env.OPENCODE_MODEL || "openai/gpt-6-luna-fast", critic: criticModel };
  const room = await createRoom(topic, rounds);
  activeRoomId = room.id;
  const roomFolder = path.join(getDataRoot(), room.id);
  mkdirSync(roomFolder, { recursive: true });
  runLogPath = path.resolve(arg("--log-file", path.join(roomFolder, "autopilot.log"))!);
  mkdirSync(path.dirname(runLogPath), { recursive: true });
  log(`Sala creada: ${room.id} | Tema: ${topic} | Máximo: ${rounds} rondas | Motor: ${engine}.`);
  if (engine === "agy") log(`Modelos Antigravity: proponente=${proposerModel}, crítico=${criticModel}.`);
  log(`Archivos de sala: ${roomFolder}`);
  log(`Registro: ${runLogPath}`);

  const sessions: {
    opencode: { id?: string };
    antigravity: { conversationId?: string };
    proposer: { conversationId?: string };
  } = { opencode: {}, antigravity: {}, proposer: {} };
  let history = compactRoomHistory([]);
  let legacyHistory = JSON.stringify({ topic, messages: [] });
  let finalProposal = "";
  let activeProposal: ActiveProposal | undefined;
  let agreed = false;

  for (let round = 1; round <= rounds && (await getRoom(room.id)).status === "open"; round++) {
    for (const side of ["opencode", "antigravity"] as const) {
      const turn = await askSeat(
        topic,
        side,
        history,
        legacyHistory,
        round === 1 && side === "opencode",
        activeProposal,
        engine,
        proposerModel,
        criticModel,
        roomFolder,
        round,
        sessions,
      );
      const via = side === "opencode" && engine === "both" ? "OpenCode CLI" : "Antigravity CLI";
      const model =
        side === "opencode" && engine === "both"
          ? process.env.OPENCODE_MODEL || "openai/gpt-6-luna-fast"
          : side === "opencode"
            ? proposerModel
            : criticModel;
      const state = await postTurn(room.id, side, turn, {
        via,
        model,
        idempotencyKey: `${room.id}:${side}:round-${round}`,
      });
      finalProposal = turn.proposal;
      history = compactRoomHistory(state.messages);
      legacyHistory = JSON.stringify({ topic, messages: state.messages }, null, 2);
      const latest = state.messages.filter((message) => message.kind !== "signoff").at(-1);
      activeProposal = latest?.revisionId ? { revisionId: latest.revisionId, text: latest.turn.proposal } : undefined;
      log(`[Ronda ${round}] ${side}: agree=${turn.agree}, puntos abiertos=${turn.open_points.length}`);
      await transcriptPath(room.id);

      if (state.phase === "signoff") {
        if (!state.agreedRevisionId) throw new Error("La sala entró en firma sin una revisión acordada.");
        const agreedProposal = { revisionId: state.agreedRevisionId, text: state.agreedPlan ?? turn.proposal };
        const prompt = signoffPrompt(topic, agreedProposal.text, room.id, agreedProposal.revisionId);
        const signoff = await withHeartbeat("Antigravity para la firma", () =>
          runAntigravity(prompt, sessions.antigravity, {
            model: criticModel,
            phase: "signoff",
            onAttempt: () => recordPromptAttempt(prompt),
            onUsage: (usage) => recordAgyUsage(usage, "signoff", criticModel),
            onRetry: (retry, delay, error) =>
              log(`Antigravity firma: reintento ${retry} en ${delay}ms: ${String(error)}`),
            onOutput: captureCliOutput(roomFolder, "signoff"),
          }),
        );
        Object.assign(sessions.antigravity, signoff.session);
        const signedTurn = enforceRevisionAcceptance(
          parseStructured(signoff.text, validateTurn, "Antigravity (firma)"),
          agreedProposal,
          "Antigravity (firma)",
        );
        const signed = await postTurn(room.id, "antigravity", signedTurn, {
          via: "Antigravity CLI",
          model: criticModel,
          idempotencyKey: `${room.id}:antigravity:signoff`,
        });
        history = compactRoomHistory(signed.messages);
        legacyHistory = JSON.stringify({ topic, messages: signed.messages }, null, 2);
        log(`Firma Antigravity: agree=${signedTurn.agree}, estado=${signed.status}`);
        agreed = signed.status === "consensus";
        if (!agreed && signed.status === "open") finalProposal = signedTurn.proposal;
        break;
      }
      if (state.status !== "open") break;
    }
    if (agreed || (await getRoom(room.id)).status !== "open") break;
  }

  let state = await getRoom(room.id);
  if (state.status === "open") state = await closeRoom(room.id, true);
  agreed = state.status === "consensus";
  history = compactRoomHistory(state.messages);
  legacyHistory = JSON.stringify({ topic, messages: state.messages, agreed_plan: state.agreedPlan }, null, 2);
  const plan = await producePlan(
    topic,
    room.id,
    history,
    legacyHistory,
    agreed,
    state.agreedPlan ?? finalProposal,
    engine,
    criticModel,
    roomFolder,
  );
  const planPath = await setPlan(room.id, plan);
  const transcript = await transcriptPath(room.id);
  mkdirSync(path.dirname(planPath), { recursive: true });
  writeFileSync(
    path.join(path.dirname(planPath), "result.json"),
    `${JSON.stringify({ roomId: room.id, status: state.status, agreed, engine, models: activeModels, plan, transcript, tokenMetrics, createdAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
  log(`Resultado: ${agreed ? "CONSENSO" : "SIN CONSENSO"}`);
  log(`Plan: ${planPath}`);
  log(`Transcripción: ${transcript}`);
  if (!agreed) process.exitCode = 1;
}

await main().catch(async (error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  if (runLogPath) appendFileSync(runLogPath, `[${new Date().toISOString()}] ERROR\n${message}\n`, "utf8");
  console.error(message);
  if (activeRoomId) {
    const roomFolder = path.join(getDataRoot(), activeRoomId);
    mkdirSync(roomFolder, { recursive: true });
    writeFileSync(path.join(roomFolder, "error.log"), `${message}\n`, "utf8");
    try {
      const room = await closeRoom(activeRoomId, true);
      const transcript = await transcriptPath(activeRoomId);
      const shortError = error instanceof Error ? error.message : String(error);
      const partialPlan: FinalPlan = {
        title: room.topic,
        summary: `Debate interrumpido antes de completar todas las intervenciones. No se alcanzó consenso. Motivo: ${shortError}`,
        decisions: [],
        steps: room.messages.length
          ? [`Reanudar el debate desde la propuesta existente: ${room.messages.at(-1)!.turn.proposal}`]
          : [],
        risks: ["El resultado es parcial y no debe tratarse como un plan aprobado."],
        dissent: ["Debate incompleto; falta al menos una intervención."],
      };
      const planPath = await setPlan(activeRoomId, partialPlan);
      writeFileSync(
        path.join(roomFolder, "result.json"),
        `${JSON.stringify({ roomId: activeRoomId, status: room.status, agreed: false, engine: activeEngine, models: activeModels, plan: partialPlan, transcript, tokenMetrics, error: shortError, createdAt: new Date().toISOString() }, null, 2)}\n`,
        "utf8",
      );
      if (runLogPath)
        appendFileSync(runLogPath, `[${new Date().toISOString()}] Plan parcial guardado: ${planPath}\n`, "utf8");
    } catch {
      /* Preserve the original failure in error.log. */
    }
  }
  process.exitCode = 1;
});
