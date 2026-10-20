import { z } from "zod";

export const SeatSchema = z.enum(["opencode", "antigravity"]);
export type Seat = z.infer<typeof SeatSchema>;

export const DebateTurnSchema = z.object({
  stance: z.string().min(1),
  critique: z.array(z.string()).default([]),
  agree: z.boolean().default(false),
  open_points: z.array(z.string()).default([]),
  proposal: z.string().min(1),
  acceptedRevisionId: z.string().regex(/^[a-f0-9]{64}$/i).nullable().optional(),
});
export type DebateTurn = z.infer<typeof DebateTurnSchema>;

export interface RoomMessage {
  seat: Seat;
  via?: "OpenCode CLI" | "Antigravity CLI";
  model?: string;
  round: number;
  turn: DebateTurn;
  revisionId?: string;
  idempotencyKey?: string;
  idempotencyFingerprint?: string;
  at: string;
  kind?: "signoff";
}

export interface DebateRoom {
  id: string;
  topic: string;
  maxRounds: number;
  status: "open" | "consensus" | "closed" | "no_consensus";
  phase: "debate" | "signoff" | "closed";
  nextSeat: Seat;
  createdAt: string;
  updatedAt: string;
  messages: RoomMessage[];
  participants: Seat[];
  agreedPlan?: string;
  agreedRevisionId?: string;
  signedBy: Seat[];
}

export const FinalPlanSchema = z.object({
  title: z.string(),
  summary: z.string(),
  decisions: z.array(z.string()),
  steps: z.array(z.string()),
  risks: z.array(z.string()),
  dissent: z.array(z.string()),
});
export type FinalPlan = z.infer<typeof FinalPlanSchema>;
