import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { closeRoom, createRoom, getDataRoot, getRoom, joinRoom, listRooms, postTurn, setPlan, transcriptPath } from "./room.js";
import { DebateTurnSchema, FinalPlanSchema, SeatSchema } from "./schema.js";

const host = "127.0.0.1";
const port = Number(process.env.DEBATE_PORT ?? 4599);

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function createMcpServer(): McpServer {
  const mcp = new McpServer({ name: "debate-room", version: "1.0.0" });

  mcp.registerTool("room_create", {
  title: "Create debate room",
  description: "Crea una sala nueva y establece opencode como primer turno.",
  inputSchema: { topic: z.string().min(1), max_rounds: z.number().int().min(1).max(20).default(6) },
}, async ({ topic, max_rounds }) => result(await createRoom(topic, max_rounds)));

  mcp.registerTool("room_list", {
  title: "List debate rooms",
  description: "Lista las salas recientes y su estado.",
  inputSchema: {},
}, async () => result(await listRooms()));

  mcp.registerTool("room_join", {
  title: "Join debate room",
  description: "Registra este agente como participante de la sala.",
  inputSchema: { room_id: z.string(), seat: SeatSchema },
}, async ({ room_id, seat }) => result(await joinRoom(room_id, seat)));

  mcp.registerTool("room_status", {
  title: "Debate status",
  description: "Devuelve estado, fase, próximo turno y puntos pendientes.",
  inputSchema: { room_id: z.string() },
}, async ({ room_id }) => {
  const room = await getRoom(room_id);
  return result({ id: room.id, topic: room.topic, status: room.status, phase: room.phase, next_seat: room.nextSeat, rounds_used: Math.ceil(room.messages.filter((message) => message.kind !== "signoff").length / 2), max_rounds: room.maxRounds, participants: room.participants, agreed_plan: room.agreedPlan, agreed_revision_id: room.agreedRevisionId });
});

  mcp.registerTool("room_post", {
  title: "Post debate turn",
   description: "Publica una crítica/propuesta estructurada respetando turnos y el máximo de rondas; acceptedRevisionId debe identificar la revisión exacta aceptada para poder alcanzar consenso. idempotency_key hace segura la repetición de una publicación.",
   inputSchema: { room_id: z.string(), seat: SeatSchema, turn: DebateTurnSchema, idempotency_key: z.string().min(1).max(180).optional() },
 }, async ({ room_id, seat, turn, idempotency_key }) => result(await postTurn(room_id, seat, turn, { idempotencyKey: idempotency_key })));

  mcp.registerTool("room_read", {
  title: "Read debate room",
  description: "Lee el tema y el historial completo de argumentos.",
  inputSchema: { room_id: z.string() },
}, async ({ room_id }) => result(await getRoom(room_id)));

  mcp.registerTool("room_wait", {
  title: "Wait for turn",
  description: "Espera hasta 55 segundos por un nuevo turno. Si devuelve idle, vuelve a llamar; MCP no puede despertar agentes inactivos.",
  inputSchema: { room_id: z.string(), seat: SeatSchema, timeout_seconds: z.number().int().min(1).max(55).default(20) },
}, async ({ room_id, seat, timeout_seconds }) => {
  const before = await getRoom(room_id);
  if (before.status !== "open") return result({ status: before.status, phase: before.phase, agreed_plan: before.agreedPlan });
  const deadline = Date.now() + timeout_seconds * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const room = await getRoom(room_id);
    if (room.status !== "open") return result({ status: room.status, phase: room.phase, agreed_plan: room.agreedPlan });
    if (room.nextSeat === seat && (room.messages.length !== before.messages.length || before.nextSeat === seat)) return result({ status: room.status, phase: room.phase, next_seat: room.nextSeat, messages: room.messages.slice(before.messages.length), agreed_plan: room.agreedPlan });
  }
  return result({ idle: true, next_seat: (await getRoom(room_id)).nextSeat });
});

  mcp.registerTool("room_save_plan", {
  title: "Save debate plan",
  description: "Guarda el plan Markdown en la carpeta de datos de la sala.",
  inputSchema: { room_id: z.string(), plan: FinalPlanSchema },
}, async ({ room_id, plan }) => result(await setPlan(room_id, plan)));

  mcp.registerTool("room_close", {
  title: "Close debate room",
  description: "Cierra la sala; permite marcar que el máximo de rondas acabó sin consenso.",
  inputSchema: { room_id: z.string(), no_consensus: z.boolean().default(false) },
}, async ({ room_id, no_consensus }) => result(await closeRoom(room_id, no_consensus)));

  mcp.registerTool("room_export_transcript", {
  title: "Export debate transcript",
  description: "Actualiza y devuelve la ruta a transcript.md.",
  inputSchema: { room_id: z.string() },
  }, async ({ room_id }) => result(await transcriptPath(room_id)));
  return mcp;
}

const http = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, name: "debate-room", dataRoot: getDataRoot() }));
    return;
  }
  if (req.url !== "/mcp") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, { allow: "POST, GET, DELETE, OPTIONS" });
    res.end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST, OPTIONS", "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));
    return;
  }
  const mcp = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await mcp.connect(transport);
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await transport.handleRequest(req, res);
  }
  catch (error) {
    console.error("MCP request failed:", error);
    void transport.close();
    void mcp.close();
    if (!res.headersSent) { res.writeHead(500, { "content-type": "text/plain" }); res.end("MCP request failed"); }
  }
});

http.listen(port, host, () => console.error(`debate-room MCP escuchando en http://${host}:${port}/mcp; datos: ${getDataRoot()}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => http.close(() => process.exit(0)));
}
