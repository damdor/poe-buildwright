// Game-neutral browser contract shared by the PoE1 and PoE2 planner surfaces.
//
// Keep event names and dispatch payloads here so individual features do not
// accidentally grow game-prefixed variants. These are internal UI events; the
// public compatibility aliases live on Window in types/shared.d.ts.

export const PLANNER_EVENTS = {
  stateChange: "buildwright-state-change",
  replayScrub: "buildwright-replay-scrub",
  notesUpdated: "buildwright-notes-updated",
} as const;

export function emitStateChange(reason: string): void {
  window.dispatchEvent(new CustomEvent(PLANNER_EVENTS.stateChange, {
    detail: { reason },
  }));
}

export function emitReplayScrub(capIdx: number): void {
  window.dispatchEvent(new CustomEvent(PLANNER_EVENTS.replayScrub, {
    detail: { capIdx },
  }));
}

export function emitNotesUpdated(): void {
  window.dispatchEvent(new CustomEvent(PLANNER_EVENTS.notesUpdated));
}
