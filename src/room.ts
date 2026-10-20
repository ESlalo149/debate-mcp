import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DebateTurnSchema, type DebateRoom, type DebateTurn, type FinalPlan, type RoomMessage, type Seat } from "./schema.js";
import { createProposalRevisionId } from "./proposal.js";

const root = path.resolve(process.env.DEBATE_DATA_DIR ?? path.join(process.cwd(), "data", "rooms"));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function roomPath(id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("Identificador de sala inválido.");
  return path.join(root, `${id}.json`);
}

async function withLock<T>(id: string, action: () => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true });
  const lockPath = `${roomPath(id)}.lock`;
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await mkdir(lockPath);
      acquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > 30_000) await rm(lockPath, { recursive: true, force: true });
      } catch { /* Another process released it. */ }
      await sleep(50 + Math.min(attempt * 10, 400));
    }
  }
  if (!acquired) throw new Error("No se pudo obtener el bloqueo de la sala; intenta de nuevo.");
  try { return await action(); }
  finally { await rm(lockPath, { recursive: true, force: true }); }
}

async function load(id: string): Promise<DebateRoom> {
  try { return JSON.parse(await readFile(roomPath(id), "utf8")) as DebateRoom; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`No existe la sala ${id}.`);
    throw error;
  }
}

async function save(room: DebateRoom): Promise<void> {
  room.updatedAt = new Date().toISOString();
  const target = roomPath(room.id);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(room, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

export async function createRoom(topic: string, maxRounds = 6): Promise<DebateRoom> {
  const normalizedTopic = topic.trim();
  if (!normalizedTopic) throw new Error("El tema no puede estar vacío.");
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 20) throw new Error("max_rounds debe estar entre 1 y 20.");
  await mkdir(root, { recursive: true });
  const now = new Date().toISOString();
  const room: DebateRoom = {
    id: `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`,
    topic: normalizedTopic,
    maxRounds,
    status: "open",
    phase: "debate",
    nextSeat: "opencode",
    createdAt: now,
    updatedAt: now,
    messages: [],
    participants: [],
    signedBy: [],
  };
  await save(room);
  return room;
}

export async function getRoom(id: string): Promise<DebateRoom> { return load(id); }

export async function listRooms(): Promise<DebateRoom[]> {
  await mkdir(root, { recursive: true });
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(root)).filter((file) => file.endsWith(".json"));
  const rooms = await Promise.all(files.map(async (file) => JSON.parse(await readFile(path.join(root, file), "utf8")) as DebateRoom));
  return rooms.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function joinRoom(id: string, seat: Seat): Promise<DebateRoom> {
  return withLock(id, async () => {
    const room = await load(id);
    if (room.status !== "open") throw new Error(`La sala está ${room.status}.`);
    if (!room.participants.includes(seat)) room.participants.push(seat);
    await save(room);
    return room;
  });
}

export interface PostTurnOptions {
  via?: RoomMessage["via"];
  model?: string;
  idempotencyKey?: string;
}

export async function postTurn(id: string, seat: Seat, input: DebateTurn, options: PostTurnOptions = {}): Promise<DebateRoom> {
  const requestedTurn = DebateTurnSchema.parse(input);
  const requestFingerprint = createHash("sha256").update(JSON.stringify(requestedTurn), "utf8").digest("hex");
  if (options.idempotencyKey && !/^[a-zA-Z0-9:._-]{1,180}$/.test(options.idempotencyKey)) {
    throw new Error("idempotencyKey debe contener 1–180 caracteres alfanuméricos, guion, punto, dos puntos o guion bajo.");
  }
  return withLock(id, async () => {
    const room = await load(id);
    if (options.idempotencyKey) {
      const duplicate = room.messages.find((message) => message.idempotencyKey === options.idempotencyKey);
      if (duplicate) {
        const sameRequest = duplicate.idempotencyFingerprint
          ? duplicate.idempotencyFingerprint === requestFingerprint
          : JSON.stringify(duplicate.turn) === JSON.stringify(requestedTurn);
        if (duplicate.seat !== seat || !sameRequest) {
          throw new Error("La idempotencyKey ya se usó con otro asiento o contenido.");
        }
        return room;
      }
    }
    if (room.status !== "open") throw new Error(`La sala está ${room.status}.`);
    const previousMessage = room.messages.filter((message) => message.kind !== "signoff").at(-1);
    const acceptedRevision = room.phase === "signoff" ? room.agreedRevisionId : previousMessage?.revisionId;
    let turn = requestedTurn;
    if (turn.agree && (!acceptedRevision
      || turn.acceptedRevisionId !== acceptedRevision
      || createProposalRevisionId(turn.proposal) !== acceptedRevision
      || turn.open_points.length > 0)) {
      turn = {
        ...turn,
        agree: false,
        acceptedRevisionId: null,
        open_points: [...turn.open_points, "La aceptación no coincide con la revisión activa o la propuesta fue modificada; revisa la versión exacta antes de aceptar."],
      };
    } else if (!turn.agree && turn.acceptedRevisionId) {
      turn = { ...turn, acceptedRevisionId: null };
    }
    const revisionId = createProposalRevisionId(turn.proposal);
    if (room.phase === "signoff") {
      if (seat !== "antigravity") throw new Error("Antigravity debe firmar o reabrir el plan.");
      const debateMessageCount = room.messages.filter((message) => message.kind !== "signoff").length;
      room.messages.push({ seat, round: Math.ceil(debateMessageCount / 2), turn, revisionId, idempotencyKey: options.idempotencyKey, idempotencyFingerprint: requestFingerprint, at: new Date().toISOString(), kind: "signoff", via: options.via, model: options.model });
      if (turn.agree && turn.open_points.length === 0 && turn.acceptedRevisionId === room.agreedRevisionId && revisionId === room.agreedRevisionId) {
        room.signedBy = ["opencode", "antigravity"];
        room.status = "consensus";
        room.phase = "closed";
      } else {
        room.phase = "debate";
        delete room.agreedPlan;
        delete room.agreedRevisionId;
        room.signedBy = [];
        room.nextSeat = "opencode";
      }
    } else {
      if (seat !== room.nextSeat) throw new Error(`Ahora le toca a ${room.nextSeat}.`);
      const debateMessages = room.messages.filter((message) => message.kind !== "signoff");
      const round = Math.floor(debateMessages.length / 2) + 1;
      if (round > room.maxRounds) {
        room.status = "no_consensus";
        await save(room);
        throw new Error("Se alcanzó el máximo de rondas sin consenso.");
      }
      const message: RoomMessage = { seat, round, turn, revisionId, idempotencyKey: options.idempotencyKey, idempotencyFingerprint: requestFingerprint, at: new Date().toISOString(), via: options.via, model: options.model };
      room.messages.push(message);
      room.nextSeat = seat === "opencode" ? "antigravity" : "opencode";
      if (debateMessages.length >= 1) {
        const latestPair = room.messages.filter((entry) => entry.kind !== "signoff").slice(-2);
        const candidateRevisionId = latestPair[0]?.revisionId;
        if (latestPair.length === 2
          && latestPair[0]?.seat === "opencode"
          && latestPair[1]?.seat === "antigravity"
          && latestPair[0]?.round === latestPair[1]?.round
          && latestPair.every((entry) => entry.turn.agree && entry.turn.open_points.length === 0)
          && !!candidateRevisionId
          && latestPair.every((entry) => entry.revisionId === candidateRevisionId && entry.turn.acceptedRevisionId === candidateRevisionId)) {
          room.phase = "signoff";
          room.agreedPlan = latestPair[0]!.turn.proposal;
          room.agreedRevisionId = candidateRevisionId;
          room.nextSeat = "antigravity";
        }
      }
      if (room.messages.filter((message) => message.kind !== "signoff").length >= room.maxRounds * 2 && room.phase !== "signoff") room.status = "no_consensus";
    }
    await save(room);
    return room;
  });
}

export async function setPlan(id: string, plan: FinalPlan): Promise<string> {
  const room = await load(id);
  const parsed = plan;
  const folder = path.join(root, room.id);
  await mkdir(folder, { recursive: true });
  const md = [
    `# ${parsed.title || room.topic}`,
    "",
    `**Tema:** ${room.topic}`,
    `**Estado:** ${room.status}`,
    `**Sala:** ${room.id}`,
    ...(room.agreedRevisionId ? [`**Revisión acordada:** ${room.agreedRevisionId}`] : []),
    "",
    "## Resumen",
    parsed.summary,
    "",
    "## Decisiones",
    ...parsed.decisions.map((item) => `- ${item}`),
    "",
    "## Pasos",
    ...parsed.steps.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## Riesgos",
    ...(parsed.risks.length ? parsed.risks.map((item) => `- ${item}`) : ["- Ninguno identificado."]),
    "",
    "## Dissent",
    ...(parsed.dissent.length ? parsed.dissent.map((item) => `- ${item}`) : ["- Sin desacuerdos pendientes."]),
    "",
  ].join("\n");
  const target = path.join(folder, "plan.md");
  await writeFile(target, md, "utf8");
  return target;
}

export async function closeRoom(id: string, noConsensus = false): Promise<DebateRoom> {
  return withLock(id, async () => {
    const room = await load(id);
    room.status = noConsensus ? "no_consensus" : "closed";
    room.phase = "closed";
    await save(room);
    return room;
  });
}

export async function transcriptPath(id: string): Promise<string> {
  const room = await load(id);
  const folder = path.join(root, room.id);
  await mkdir(folder, { recursive: true });
  const lines = [`# Debate: ${room.topic}`, "", `Sala: ${room.id} | Estado: ${room.status} | Fase: ${room.phase}`, ""];
  for (const message of room.messages) {
    const speaker = [message.seat, message.via, message.model].filter(Boolean).join(" · ");
    lines.push(`## ${message.kind === "signoff" ? "Firma final" : `Ronda ${message.round}`} — ${speaker} (${message.at})`, "", ...(message.revisionId ? [`**Revisión propuesta:** ${message.revisionId}`] : []), ...(message.turn.acceptedRevisionId ? [`**Revisión aceptada:** ${message.turn.acceptedRevisionId}`] : []), "", `**Postura:** ${message.turn.stance}`, "", "**Crítica:**", ...(message.turn.critique.length ? message.turn.critique.map((x) => `- ${x}`) : ["- Ninguna"]), "", `**Acuerdo:** ${message.turn.agree ? "Sí" : "No"}`, "", "**Puntos abiertos:**", ...(message.turn.open_points.length ? message.turn.open_points.map((x) => `- ${x}`) : ["- Ninguno"]), "", "**Propuesta:**", message.turn.proposal, "");
  }
  const target = path.join(folder, "transcript.md");
  await writeFile(target, `${lines.join("\n")}\n`, "utf8");
  return target;
}

export function getDataRoot(): string { return root; }
