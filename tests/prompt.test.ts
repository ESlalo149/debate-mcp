import assert from "node:assert/strict";
import test from "node:test";
import { compactRoomHistory } from "../src/prompt.js";
import type { RoomMessage } from "../src/schema.js";

function message(seat: RoomMessage["seat"], round: number, kind?: RoomMessage["kind"]): RoomMessage {
  return {
    seat,
    via: "Antigravity CLI",
    model: "gemini-3.8-flash-low",
    round,
    turn: {
      stance: `Postura ${round}: ${"s".repeat(400)}`,
      critique: Array.from({ length: 7 }, (_, index) => `Crítica ${index}: ${"c".repeat(400)}`),
      agree: false,
      open_points: Array.from({ length: 7 }, (_, index) => `Punto ${index}: ${"o".repeat(400)}`),
      proposal: `Propuesta completa ${round}: ${"p".repeat(800)}`,
      acceptedRevisionId: null,
    },
    revisionId: "a".repeat(64),
    idempotencyKey: `key-${round}`,
    idempotencyFingerprint: "b".repeat(64),
    at: new Date(0).toISOString(),
    kind,
  };
}

test("compact history omits persisted metadata, proposals, and signoff while preserving debate context", () => {
  const messages = [message("opencode", 1), message("antigravity", 1), message("antigravity", 1, "signoff")];
  const compact = JSON.parse(compactRoomHistory(messages)) as Array<Record<string, unknown>>;

  assert.equal(compact.length, 2);
  assert.deepEqual(Object.keys(compact[0]!).sort(), ["agree", "critique", "open_points", "round", "seat", "stance"]);
  assert.equal(compact[0]!.seat, "opencode");
  assert.equal(compact[0]!.round, 1);
  assert.equal(compact[0]!.agree, false);
  assert.equal((compact[0]!.stance as string).length, 220);
  assert.equal((compact[0]!.critique as string[]).length, 5);
  assert.match((compact[0]!.critique as string[])[4]!, /more omitted/);

  const legacyBytes = Buffer.byteLength(JSON.stringify({ topic: "Topic", messages }, null, 2), "utf8");
  const compactBytes = Buffer.byteLength(compactRoomHistory(messages), "utf8");
  assert.ok(compactBytes < legacyBytes * 0.35, `expected >65% reduction, got ${legacyBytes} -> ${compactBytes}`);
});
