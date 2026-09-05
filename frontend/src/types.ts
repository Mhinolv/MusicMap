// ---- API shapes (mirror backend/app/models) --------------------------------

export type ArtistRef = {
  id: string
  mbid?: string | null
  name: string
  lastfm_url?: string | null
  image_url?: string | null
}

export type SimilarArtist = ArtistRef & { similarity?: number | null }

export type TrackRef = {
  id: string
  name: string
  artist: ArtistRef
  mbid?: string | null
  lastfm_url?: string | null
  listeners?: number | null
}

export type SimilarTrack = TrackRef & {
  /** Blend of Last.fm's collaborative match and shared-tag similarity. */
  similarity?: number | null
  /** Tags both songs carry — why the content half of the score fired. */
  shared_tags?: string[]
}

export type TrackAlbum = {
  title: string
  mbid?: string | null
  url?: string | null
  image_url?: string | null
}

export type TrackDetails = TrackRef & {
  album?: TrackAlbum | null
  duration_seconds?: number | null
  playcount?: number | null
  tags: string[]
  summary?: string | null
  /** "YYYY", "YYYY-MM" or "YYYY-MM-DD" from MusicBrainz. */
  release_date?: string | null
  external_urls: ExternalUrls
}

export type ExternalUrls = {
  lastfm?: string | null
  spotify?: string | null
  apple_music?: string | null
  youtube?: string | null
  musicbrainz?: string | null
}

export type Artist = ArtistRef & {
  tags: string[]
  listeners?: number | null
  summary?: string | null
  external_urls: ExternalUrls
}

export type Track = {
  name: string
  listeners?: number | null
  playcount?: number | null
  lastfm_url?: string | null
}

export type PreviewResult = {
  available: boolean
  preview_url?: string | null
  duration_seconds?: number | null
  provider?: string | null
  track_url?: string | null
  artwork_url?: string | null
}

// ---- Graph state (MVP §8) -------------------------------------------------

/** A map is rooted at either an artist or a song; every other node is an artist. */
export type NodeKind = 'artist' | 'track'

export type ArtistNode = {
  id: string
  kind: NodeKind
  mbid?: string
  name: string
  expanded: boolean
  loading: boolean
  error?: string
  tags?: string[]
  imageUrl?: string
  /** The node whose expansion first brought this artist into the graph. */
  parentId?: string
  /** Track nodes only: who performs the song. */
  artist?: ArtistRef
  /** Second label line under the name (track nodes show their artist). */
  subtitle?: string
}

export type ArtistEdge = {
  id: string
  source: string
  target: string
  similarity?: number
  /** Song edges only: tags shared by both endpoints. */
  sharedTags?: string[]
}

export type PruneMode = 'collapse' | 'remove'

export type MusicGraph = {
  nodes: Map<string, ArtistNode>
  edges: Map<string, ArtistEdge>
  selectedNodeId?: string
  rootId?: string
  /** Last node that was expanded. Visual emphasis radiates from here. */
  focusId?: string
  /** Ordered ids of every node the user has expanded: the exploration trail. */
  journey: string[]
  /** One-level undo for destructive edits (collapse / remove a branch). */
  undo?: { graph: MusicGraph; summary: string; seq: number }
}

export function edgeId(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`
}
