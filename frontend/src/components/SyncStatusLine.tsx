import { SYNC_TEXT, syncWarns, type SyncStatus } from '../tasteSync'

/** Signed-in sync state for taste (#76) and the Library (#79). It never blocks an edit. */
export function SyncStatusLine({ status, className = '' }: { status: SyncStatus; className?: string }) {
  return <p className={`${className ? `${className} ` : ''}taste-sync${syncWarns(status) ? ' taste-sync--warn' : ''}`} role="status">{SYNC_TEXT[status]}</p>
}
