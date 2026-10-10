import { ApiError } from './api'
import { tasteErrorMessage } from './tasteError'
import type { TasteSteer } from './types'

/** Same bounds as POST /api/taste/steer-tags and the #8 chip cap. */
export const STEER_MAX_CHARS = 200
export const STEER_MAX_TAGS = 12
export const STEER_MAX_CHIPS = 3
/** The {n}/200 counter shows from here on. */
export const STEER_COUNTER_FROM = 160

export const AVOID_NOTICE = "Steering away from a sound isn't supported yet, so that part was left out."
export const NO_MATCH_NOTICE = "None of this song's tags matched. Try words closer to the tags below, or pick them yourself."
export const LOW_CONFIDENCE_NOTICE = "Couldn't tell which tags you meant. Pick them below instead."

/** The tags sent as the allowlist: the first twelve, as the backend checks them. */
export const steerAllowlist = (tags: string[]) => tags.slice(0, STEER_MAX_TAGS)

/** Proposed chips, kept to the song's own tags and the three-tag cap. */
export function proposedChips(result: TasteSteer, tags: string[]): string[] {
  if (result.outcome !== 'proposed') return []
  return result.tags.filter((tag) => tags.includes(tag)).slice(0, STEER_MAX_CHIPS)
}

/** Why some or all of the request was not turned into chips. Avoid tags are never chips. */
export function steerNotices(result: TasteSteer, tags: string[]): string[] {
  const notices = result.avoid_ignored ? [AVOID_NOTICE] : []
  if (result.outcome === 'low_confidence') notices.push(LOW_CONFIDENCE_NOTICE)
  else if (!proposedChips(result, tags).length && !result.avoid_ignored) notices.push(NO_MATCH_NOTICE)
  return notices
}

/** 503 has its own copy; busy, timeout and unreadable answers reuse #36's. */
export function steerErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return "Couldn't interpret that right now. Please retry."
  if (err.status === 503) return 'Plain-word steering is not configured on this server.'
  if (err.status === 429 || err.status === 504 || (err.status === 502 && err.message === 'invalid response')) return tasteErrorMessage(err)
  return "Couldn't interpret that right now. Please retry."
}
