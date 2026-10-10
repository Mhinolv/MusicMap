import type { ArtistNode, TasteProfile } from '../types'
import { storedTasteEntry, tasteEntry, type TasteList } from '../taste'

type Props = {
  node: ArtistNode
  profile: TasteProfile | null
  onToggle: (list: TasteList, entry: string) => void
}

export function TasteToggle({ node, profile, onToggle }: Props) {
  const entry = tasteEntry(node)
  const list = node.kind === 'track' ? 'liked_tracks' : 'liked_artists'
  const liked = storedTasteEntry(profile, list, entry)
  const disliked = storedTasteEntry(profile, 'disliked', entry)
  return (
    <div className="taste-toggle">
      <div className="taste-check__actions">
        <button type="button" className="btn btn--ghost taste-toggle__like" disabled={!entry} aria-pressed={liked !== undefined} onClick={() => onToggle(list, entry)}>
          {liked !== undefined ? 'Remove from my taste' : 'Add to my taste'}
        </button>
        <button type="button" className="btn btn--ghost taste-toggle__dislike" disabled={!entry} aria-pressed={disliked !== undefined} onClick={() => onToggle('disliked', entry)}>
          {disliked !== undefined ? 'Remove from dislikes' : 'Not my taste'}
        </button>
      </div>
      {liked !== undefined && <p className="panel__hint">In your taste: {liked}</p>}
      {disliked !== undefined && <p className="panel__hint">In your dislikes: {disliked}</p>}
    </div>
  )
}
