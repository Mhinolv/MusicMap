import type { ArtistNode } from '../types'

export const JOURNEY_CAP = 50

/** Ordered expanded songs across branches, plus the current expansion seed. */
export function journeyContext(journey: string[], nodes: Map<string, ArtistNode>, seed: string): string[] {
  return [...new Set([
    ...journey.filter((id) => nodes.get(id)?.kind === 'track' && nodes.get(id)?.expanded), seed,
  ])]
}
