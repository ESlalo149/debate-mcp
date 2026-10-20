import { createHash } from "node:crypto";

export function canonicalizeProposal(text: string): string {
  return text.normalize("NFKC").replace(/\r\n?/g, "\n").trim();
}

export function createProposalRevisionId(text: string): string {
  return createHash("sha256").update(canonicalizeProposal(text), "utf8").digest("hex");
}
