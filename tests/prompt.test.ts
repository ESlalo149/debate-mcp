import assert from "node:assert/strict";
import test from "node:test";
import { compactRoomHistory } from "../src/prompt.js";
import type { RoomMessage } from "../src/schema.js";

function message(
  seat: RoomMessage["seat"],
  round: number,
  kind?: RoomMessage["kind"],
  stance = `Postura ${round}: ${"s".repeat(800)}`,
): RoomMessage {
  return {
    seat,
    via: "Antigravity CLI",
    model: "gemini-3.8-flash-low",
    round,
    turn: {
      stance,
      critique: Array.from({ length: 7 }, (_, index) => `Crítica ${index}: ${"c".repeat(800)}`),
      agree: false,
      open_points: Array.from({ length: 7 }, (_, index) => `Punto ${index}: ${"o".repeat(800)}`),
      proposal: `Propuesta completa ${round}: ${"p".repeat(1600)}`,
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
  assert.equal((compact[0]!.stance as string).length, 400);
  assert.equal((compact[0]!.critique as string[]).length, 5);
  assert.match((compact[0]!.critique as string[])[4]!, /more omitted/);

  const legacyBytes = Buffer.byteLength(JSON.stringify({ topic: "Topic", messages }, null, 2), "utf8");
  const compactBytes = Buffer.byteLength(compactRoomHistory(messages), "utf8");
  assert.ok(compactBytes < legacyBytes * 0.35, `expected >65% reduction, got ${legacyBytes} -> ${compactBytes}`);
});

test("compact text truncates at a nearby word boundary", () => {
  const stance = "palabra ".repeat(100);
  const compact = JSON.parse(compactRoomHistory([message("opencode", 1, undefined, stance)])) as Array<{
    stance: string;
  }>;

  assert.ok(compact[0]!.stance.length <= 400);
  assert.ok(compact[0]!.stance.length >= 357);
  assert.match(compact[0]!.stance, /(?:^|\s)palabra\.\.\.$/);
});

test("compact text hard-cuts long unbroken strings and preserves text at the exact limit", () => {
  const unbroken = "x".repeat(800);
  const compactUnbroken = JSON.parse(compactRoomHistory([message("opencode", 1, undefined, unbroken)])) as Array<{
    stance: string;
  }>;
  const exactLimit = "x".repeat(400);
  const compactExactLimit = JSON.parse(compactRoomHistory([message("opencode", 1, undefined, exactLimit)])) as Array<{
    stance: string;
  }>;

  assert.equal(compactUnbroken[0]!.stance.length, 400);
  assert.ok(compactUnbroken[0]!.stance.endsWith("..."));
  assert.equal(compactExactLimit[0]!.stance, exactLimit);
});
