import type { TasteEvaluation } from './types'

// Shared taste-fit vocabulary (#36, reused by #37). Never format a Score as a percent.

export type FitBandKey = 'strong' | 'likely' | 'mixed' | 'unlikely' | 'conflict' | 'insufficient' | 'uncertain'
export type FitTone = 'accent' | 'text' | 'dim' | 'conflict' | 'uncertain'
export type FitBand = { key: FitBandKey; label: string; tone: FitTone; pips: number }

export const FIT_PIPS = 5

const LEVELS: FitBand[] = [
  { key: 'conflict', label: 'Conflicts with your dislikes', tone: 'conflict', pips: 1 },
  { key: 'unlikely', label: 'Unlikely fit', tone: 'dim', pips: 2 },
  { key: 'mixed', label: 'Mixed signals', tone: 'text', pips: 3 },
  { key: 'likely', label: 'Likely fit', tone: 'accent', pips: 4 },
  { key: 'strong', label: 'Strong fit', tone: 'accent', pips: 5 },
]
const INSUFFICIENT: FitBand = { key: 'insufficient', label: 'Not enough information', tone: 'uncertain', pips: 0 }
const UNCERTAIN: FitBand = { key: 'uncertain', label: 'Uncertain estimate', tone: 'uncertain', pips: 0 }

/** Uncertainty outcomes sit outside the ordered scale: no pips, never a leaning band. */
export function bandFor(result: Pick<TasteEvaluation, 'outcome' | 'level'>): FitBand {
  if (result.outcome === 'insufficient_evidence') return INSUFFICIENT
  if (result.outcome !== 'fit' || result.level === null || !Number.isFinite(result.level)) return UNCERTAIN
  return LEVELS[Math.min(LEVELS.length - 1, Math.max(0, Math.round(result.level)))]
}

export function uncertainHint(band: FitBand, kind: 'artist' | 'track'): string | null {
  if (band.key === 'insufficient') {
    return `Your preferences and this ${kind === 'track' ? 'song' : 'artist'}'s tags don't overlap enough to judge. Adding genres you like helps.`
  }
  return band.key === 'uncertain' ? "The model's answer was split, so no fit is shown." : null
}
