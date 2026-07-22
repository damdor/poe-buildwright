// ============================================================================
// === Game-owned asset loader =================================================
// ============================================================================
// Every game-data fetch goes through this seam. The rendered page declares
// exact URLs (not a directory convention), and every JSON payload declares
// its owning game. A cross-wired deploy therefore fails loudly instead of
// silently presenting PoE2 data on a PoE1 page (or vice versa).

import { GAME, type GameAssetKey, assetUrl } from "./game.ts";

interface GameEnvelope { game?: unknown; format?: unknown; }

export function assertGameEnvelope(value: unknown, key: GameAssetKey, url: string): void {
  if (!value || typeof value !== "object") {
    throw new Error(`${key}: ${url} did not return a JSON object`);
  }
  const envelope = value as GameEnvelope;
  if (envelope.game !== GAME.id) {
    throw new Error(
      `${key}: expected ${GAME.id} data from ${url}, got game=${JSON.stringify(envelope.game)}`,
    );
  }
}

export async function loadGameAsset<T>(key: GameAssetKey): Promise<T | null> {
  const url = assetUrl(key);
  if (!url) return null;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${key}: ${url} returned HTTP ${response.status}`);
  const value = await response.json() as unknown;
  assertGameEnvelope(value, key, url);
  return value as T;
}
