import type { RoomMessage } from "./schema.js";

const MAX_HISTORY_ITEMS = 5;
const MAX_HISTORY_TEXT_LENGTH = 400;
const MAX_WORD_BOUNDARY_BACKTRACK = 40;

function compactText(value: string): string {
  if (value.length <= MAX_HISTORY_TEXT_LENGTH) return value;

  const maxContentLength = MAX_HISTORY_TEXT_LENGTH - 3;
  const prefix = value.slice(0, maxContentLength);
  const lastWordStart = prefix.search(/\s+\S*$/u);

  if (lastWordStart >= maxContentLength - MAX_WORD_BOUNDARY_BACKTRACK && lastWordStart > 0) {
    return `${prefix.slice(0, lastWordStart).trimEnd()}...`;
  }

  return `${prefix}...`;
}

function compactList(values: string[]): string[] {
  if (values.length <= MAX_HISTORY_ITEMS) return values.map(compactText);
  return [
    ...values.slice(0, MAX_HISTORY_ITEMS - 1).map(compactText),
    `... (${values.length - MAX_HISTORY_ITEMS + 1} more omitted)`,
  ];
}

export function compactRoomHistory(messages: readonly RoomMessage[]): string {
  const history = messages
    .filter((message) => message.kind !== "signoff")
    .map(({ seat, round, turn }) => ({
      seat,
      round,
      stance: compactText(turn.stance),
      critique: compactList(turn.critique),
      open_points: compactList(turn.open_points),
      agree: turn.agree,
    }));

  return JSON.stringify(history);
}
