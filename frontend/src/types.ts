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

export type TrackRankingContext = {
  steering_matched?: boolean | null
  mode: 'parent' | 'journey'
  stop_count: number
  fallback_reason: 'cap_exceeded' | 'timeout' | 'missing_tags' | null
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

export type TasteProfile = {
  liked_artists: string[]
  liked_tracks: string[]
  liked_genres: string[]
  disliked: string[]
  notes: string
}

/** `fit` carries a Score level, `uncertain` a tentative (leaning) one (#51);
 *  `insufficient_evidence` deliberately carries none. */
export type TasteOutcome = 'fit' | 'insufficient_evidence' | 'uncertain'

/** `/api/taste/evaluate` v2. There is no enjoyment probability to display. */
export type TasteEvaluation = {
  version: 2
  kind: 'artist' | 'track'
  item_id: string
  outcome: TasteOutcome
  /** 0 = conflicts with your dislikes … 4 = strong fit; null for `insufficient_evidence`. */
  level: number | null
  score: number | null
  /** 0–1, only for `uncertain`. Never displayed; every uncertain result shares one style. */
  confidence?: number | null
  model?: string | null
  rubric_version: string
  tags: string[]
  /** Mock-mode fixture rather than a real JEV judgment. */
  simulated: boolean
}

/** `unknown`: that song's facts or JEV's answer for it were unusable; only it failed. */
export type TasteConnectionOutcome = TasteOutcome | 'unknown'

export type TasteConnectionResult = {
  item_id: string
  outcome: TasteConnectionOutcome
  level: number | null
  score: number | null
  confidence?: number | null
}

/** `/api/taste/connections/evaluate` v1: one result per requested song, in request order. */
export type TasteConnections = {
  version: 1
  results: TasteConnectionResult[]
  model?: string | null
  rubric_version: string
  simulated: boolean
}

/** Plain-word steering (#38): up to three of the seed song's own tags, never invented. */
export type TasteSteer = {
  version: 1
  /** `proposed` has 1–3 tags; `no_match` and `low_confidence` have none. */
  outcome: 'proposed' | 'no_match' | 'low_confidence'
  tags: string[]
  /** The request also asked for less of something; that part is not applied. */
  avoid_ignored: boolean
  model?: string | null
  rubric_version: string
  simulated: boolean
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
  /** Context actually used for this expansion, separate from edge similarity. */
  ranking?: TrackRankingContext
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
