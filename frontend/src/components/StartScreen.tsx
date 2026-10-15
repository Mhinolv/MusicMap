import { useMemo, type ComponentProps, type Ref } from 'react'
import type { SavedMap } from '../graph/mapSnapshot'
import { miniMap, resumeSummary } from '../startScreen'
import type { MusicGraph } from '../types'
import { BrandMark } from './BrandMark'
import { LibraryButton } from './LibraryDrawer'
import { SearchBar } from './SearchBar'
import { StartBackdrop } from './StartBackdrop'

type Props = {
  savedMap: SavedMap
  search: Omit<ComponentProps<typeof SearchBar>, 'start' | 'primary' | 'compact' | 'autoFocus'>
  libraryCount: number
  libraryOpen: boolean
  onToggleLibrary: () => void
  libraryButton: Ref<HTMLButtonElement>
  onTaste: () => void
  onResume: () => void
  onStartFresh: () => void
}

const TONE = { amber: 'var(--amber)', cyan: 'var(--cyan)', star: 'var(--star)' }

function MiniMapThumb({ graph }: { graph: MusicGraph }) {
  const map = useMemo(() => miniMap(graph), [graph])
  return (
    <svg className="resume__map" aria-hidden="true" width="200" height="120" viewBox="0 0 200 120">
      {map.links.map((l) => <line key={l.id} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="var(--border)" strokeWidth="1" />)}
      {map.journey && <path d={map.journey} fill="none" stroke="var(--amber)" strokeWidth="1.5" strokeDasharray="3 3" />}
      {map.stars.map((s) => <circle key={s.id} cx={s.x} cy={s.y} r={s.r} fill={TONE[s.tone]} />)}
    </svg>
  )
}

export function StartScreen({ savedMap, search, libraryCount, libraryOpen, onToggleLibrary, libraryButton, onTaste, onResume, onStartFresh }: Props) {
  const resumable = savedMap.status === 'ready'
  const summary = resumable ? resumeSummary(savedMap.snapshot.graph) : undefined
  return (
    <>
      <header className="start-header">
        <BrandMark />
        <span className="start-header__name" aria-hidden="true">TuneGraph</span>
        <span className="start-header__spacer" />
        <LibraryButton count={libraryCount} open={libraryOpen} onToggle={onToggleLibrary} buttonRef={libraryButton} />
        <button type="button" className="taste-entry start-header__taste" onClick={onTaste}>Taste</button>
      </header>
      <StartBackdrop />
      <main className={`start ${libraryOpen ? 'start--library' : ''}`}>
        <h1 className="sr-only">TuneGraph</h1>
        <div className="start-intro">
          <p className="start-intro__title">Map the music around any artist or song</p>
          <p className="start-intro__text">Search a name, then branch out through related artists or songs, with a 30-second preview at every stop.</p>
        </div>
        <section className="start-panel" aria-labelledby="new-map-title">
          <div className="start-panel__head">
            <h2 id="new-map-title">New map</h2>
            <span className="start-panel__aside">enter to start · tab to switch mode</span>
          </div>
          <div className="start-panel__body">
            <SearchBar {...search} start primary={!resumable} autoFocus />
          </div>
          <p className="start-panel__hint">
            {search.mode === 'song' ? 'Try “Creep”, “Glory Box”, or “Teardrop”.' : 'Try “Radiohead”, “Portishead”, or “Björk”.'}
          </p>
        </section>
        {summary && savedMap.status === 'ready' && (
          <section className="start-panel resume-card resume-card--ready" aria-labelledby="resume-title">
            <div className="start-panel__head">
              <h2 id="resume-title">Resume where you left off</h2>
              <span className="start-panel__aside">autosaved on this device</span>
            </div>
            <div className="start-panel__body resume">
              <MiniMapThumb graph={savedMap.snapshot.graph} />
              <div className="resume__info">
                <p className="resume__title" title={summary.title}>{summary.title}</p>
                <dl className="resume__facts">
                  <div><dt>Mode</dt><dd>{summary.mode}</dd></div>
                  <div><dt>Stops</dt><dd>{summary.stops}</dd></div>
                  <div><dt>{summary.countLabel}</dt><dd>{summary.nodes}</dd></div>
                  <div><dt>Links</dt><dd>{summary.links}</dd></div>
                </dl>
              </div>
              <div className="resume__actions">
                <button type="button" className="btn btn--primary resume__go" onClick={onResume}>Resume</button>
                <button type="button" className="btn resume__discard" onClick={onStartFresh} aria-label="Discard saved map and start fresh">Discard</button>
              </div>
            </div>
          </section>
        )}
        {savedMap.status === 'invalid' && (
          <section className="start-panel resume-card resume-card--invalid" aria-labelledby="resume-title">
            <div className="start-panel__head">
              <h2 id="resume-title">Last map couldn't be restored</h2>
            </div>
            <div className="start-panel__body resume">
              <p className="resume__damaged">It was damaged or too large to load.</p>
              <button type="button" className="btn resume__discard" onClick={onStartFresh}>Start fresh</button>
            </div>
          </section>
        )}
      </main>
    </>
  )
}
