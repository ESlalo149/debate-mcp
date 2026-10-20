import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeProposal, createProposalRevisionId } from "../src/proposal.js";

test("proposal revision IDs normalize NFKC and line endings deterministically", () => {
  const composed = "  Plan de migración\r\nFase 1  ";
  const decomposed = "Plan de migracio\u0301n\nFase 1";
  assert.equal(canonicalizeProposal(composed), canonicalizeProposal(decomposed));
  assert.equal(createProposalRevisionId(composed), createProposalRevisionId(decomposed));
  assert.notEqual(createProposalRevisionId(composed), createProposalRevisionId("Plan de migración\nFase 2"));
});
