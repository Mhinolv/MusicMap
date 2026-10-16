import { SYNC_TEXT, syncWarns, type SyncStatus } from '../tasteSync'

/** Signed-in taste sync state (#76). It never blocks Save or Clear. */
export function SyncStatusLine({ status }: { status: SyncStatus }) {
  return <p className={`taste-sync${syncWarns(status) ? ' taste-sync--warn' : ''}`} role="status">{SYNC_TEXT[status]}</p>
}
