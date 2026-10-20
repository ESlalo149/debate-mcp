import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { createProposalRevisionId } from "../src/proposal.js";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "debate-mcp-room-tests-"));
process.env.DEBATE_DATA_DIR = dataDir;
const { createRoom, getRoom, postTurn } = await import("../src/room.js");
after(async () => rm(dataDir, { recursive: true, force: true }));

function turn(
  proposal: string,
  options: { agree?: boolean; acceptedRevisionId?: string | null; openPoints?: string[] } = {},
) {
  return {
    stance: options.agree ? "Acepto la revisión" : "Propongo revisar la solución",
    critique: [],
    agree: options.agree ?? false,
    open_points: options.openPoints ?? (options.agree ? [] : ["Falta validar el alcance."]),
    proposal,
    acceptedRevisionId: options.acceptedRevisionId ?? null,
  };
}

test("posts are idempotent and consensus requires exact accepted revision and a final signature", async () => {
  const room = await createRoom("Probar transición con revisiones", 3);
  const proposalA = "Migrar por módulos y mantener pruebas.";
  const proposalB = "Migrar por módulos, activar strict para código nuevo y medir excepciones.";
  const revisionB = createProposalRevisionId(proposalB);

  const first = await postTurn(room.id, "opencode", turn(proposalA), { idempotencyKey: `${room.id}:opencode:round-1` });
  const duplicate = await postTurn(room.id, "opencode", turn(proposalA), {
    idempotencyKey: `${room.id}:opencode:round-1`,
  });
  assert.equal(duplicate.messages.length, 1);
  assert.equal(first.messages[0]?.revisionId, createProposalRevisionId(proposalA));
  await assert.rejects(
    () => postTurn(room.id, "opencode", turn("different"), { idempotencyKey: `${room.id}:opencode:round-1` }),
    /idempotencyKey ya se usó/,
  );

  await postTurn(room.id, "antigravity", turn(proposalB), { idempotencyKey: `${room.id}:antigravity:round-1` });
  await postTurn(room.id, "opencode", turn(proposalB, { agree: true, acceptedRevisionId: revisionB }), {
    idempotencyKey: `${room.id}:opencode:round-2`,
  });
  const accepted = await postTurn(
    room.id,
    "antigravity",
    turn(proposalB, { agree: true, acceptedRevisionId: revisionB }),
    { idempotencyKey: `${room.id}:antigravity:round-2` },
  );
  assert.equal(accepted.phase, "signoff");
  assert.equal(accepted.agreedPlan, proposalB);
  assert.equal(accepted.agreedRevisionId, revisionB);

  const signed = await postTurn(
    room.id,
    "antigravity",
    turn(proposalB, { agree: true, acceptedRevisionId: revisionB }),
    { idempotencyKey: `${room.id}:antigravity:signoff` },
  );
  assert.equal(signed.status, "consensus");
  assert.deepEqual(signed.signedBy, ["opencode", "antigravity"]);
  const repeatedSignoff = await postTurn(
    room.id,
    "antigravity",
    turn(proposalB, { agree: true, acceptedRevisionId: revisionB }),
    { idempotencyKey: `${room.id}:antigravity:signoff` },
  );
  assert.equal(repeatedSignoff.status, "consensus");
  assert.equal((await getRoom(room.id)).messages.filter((message) => message.kind === "signoff").length, 1);
});

test("mismatched or edited revisions cannot trigger consensus", async () => {
  const room = await createRoom("No aceptar una revisión distinta", 3);
  const proposal = "Versión guardada";
  const revisionId = createProposalRevisionId(proposal);
  await postTurn(room.id, "opencode", turn(proposal));
  await postTurn(room.id, "antigravity", turn(proposal));
  await postTurn(room.id, "opencode", turn(`${proposal} con cambios`, { agree: true, acceptedRevisionId: revisionId }));
  const state = await postTurn(
    room.id,
    "antigravity",
    turn(`${proposal} con cambios`, { agree: true, acceptedRevisionId: revisionId }),
  );
  assert.equal(state.phase, "debate");
  assert.equal(state.status, "open");
  assert.equal(state.agreedPlan, undefined);
});

test("the opening turn cannot claim acceptance before a candidate proposal exists", async () => {
  const room = await createRoom("No aceptar antes de una propuesta", 2);
  const proposal = "Propuesta de apertura";
  const revisionId = createProposalRevisionId(proposal);
  const state = await postTurn(room.id, "opencode", turn(proposal, { agree: true, acceptedRevisionId: revisionId }));
  assert.equal(state.messages[0]?.turn.agree, false);
  assert.equal(state.messages[0]?.turn.acceptedRevisionId, null);
  assert.equal(state.phase, "debate");
  assert.equal(state.agreedPlan, undefined);
});
