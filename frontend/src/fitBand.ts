import type { TasteEvaluation } from './types'

// Shared taste-fit vocabulary (#36, reused by #37). Never format a Score as a percent.

export type FitBandKey = 'strong' | 'likely' | 'mixed' | 'unlikely' | 'conflict' | 'insufficient' | 'uncertain'
export type FitTone = 'accent' | 'text' | 'dim' | 'conflict' | 'uncertain'
/** `tentative`: an uncertain estimate's leaning level (#51), drawn with ring pips and a `Leaning:` prefix. */
export type FitBand = { key: FitBandKey; label: string; tone: FitTone; pips: number; tentative: boolean }

export const FIT_PIPS = 5

const LEVELS: FitBand[] = [
  { key: 'conflict', label: 'Conflicts with your dislikes', tone: 'conflict', pips: 1, tentative: false },
  { key: 'unlikely', label: 'Unlikely fit', tone: 'dim', pips: 2, tentative: false },
  { key: 'mixed', label: 'Mixed signals', tone: 'text', pips: 3, tentative: false },
  { key: 'likely', label: 'Likely fit', tone: 'accent', pips: 4, tentative: false },
  { key: 'strong', label: 'Strong fit', tone: 'accent', pips: 5, tentative: false },
]
const INSUFFICIENT: FitBand = { key: 'insufficient', label: 'Not enough information', tone: 'uncertain', pips: 0, tentative: false }
const UNCERTAIN: FitBand = { key: 'uncertain', label: 'Uncertain estimate', tone: 'uncertain', pips: 0, tentative: false }

/** Not enough information never has a level. An uncertain estimate keeps its leaning level as
 *  a tentative band in the uncertain tone; without a finite level (old or malformed data) it
 *  falls back to the zero-pip "Uncertain estimate". */
export function bandFor(result: Pick<TasteEvaluation, 'outcome' | 'level'>): FitBand {
  if (result.outcome === 'insufficient_evidence') return INSUFFICIENT
  const scored = result.outcome === 'fit' || result.outcome === 'uncertain'
  if (!scored || result.level === null || !Number.isFinite(result.level)) return UNCERTAIN
  const band = LEVELS[Math.min(LEVELS.length - 1, Math.max(0, Math.round(result.level)))]
  return result.outcome === 'uncertain' ? { ...band, tone: 'uncertain', tentative: true } : band
}

export function uncertainHint(band: FitBand, kind: 'artist' | 'track'): string | null {
  if (band.key === 'insufficient') {
    return `Your preferences and this ${kind === 'track' ? 'song' : 'artist'}'s tags don't overlap enough to judge. Adding genres you like helps.`
  }
  if (band.tentative) return "The model's answer was split, so this is a tentative lean, not a firm fit."
  return band.key === 'uncertain' ? "The model's answer was split, so no fit could be estimated." : null
}
