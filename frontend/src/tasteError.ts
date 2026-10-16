import { ApiError } from './api'

/** #36 copy for a failed taste request, shared by Check my taste and Check these connections. */
export function tasteErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Could not check your taste right now. Please retry.'
  if (err.status === 503) return 'Taste checks are not configured on this server.'
  if (err.status === 429) return 'The taste check is busy. Try again shortly.'
  if (err.status === 504) return 'The taste check took too long to answer. Try again.'
  if (err.status === 502 && err.message === 'invalid response') return "The taste check sent an answer we couldn't read. Try again."
  return 'Could not check your taste right now. Please retry.'
}
