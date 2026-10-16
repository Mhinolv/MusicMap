// Account labels and the Google Identity Services loader (#75). Sign-in is optional.
import type { AuthUser } from './types'

export const ACCOUNT_MENU_ID = 'account-menu'
export const ACCOUNT_LABEL_MAX = 12
export const SIGN_IN_ERROR = "Couldn't sign in. Try again."

/** First word of the display name (or the email's local part), cut to 12 characters. */
export function accountLabel(user: AuthUser | null): string {
  if (!user) return 'Sign in'
  const first = user.name.trim().split(/\s+/)[0] || user.email.split('@')[0] || 'Account'
  return [...first].slice(0, ACCOUNT_LABEL_MAX).join('')
}

export function accountAriaLabel(user: AuthUser | null): string {
  return user ? `Account, signed in as ${user.name.trim() || user.email}` : 'Sign in'
}

export const signedInToast = (user: AuthUser) => `Signed in as ${user.name.trim() || user.email}.`

// ---- Google Identity Services -----------------------------------------------------

type GsiButtonOptions = { theme: string; size: string; text: string; shape: string; width: number }
type Gsi = {
  accounts: { id: {
    initialize: (options: { client_id: string; callback: (response: { credential?: string }) => void }) => void
    renderButton: (parent: HTMLElement, options: GsiButtonOptions) => void
  } }
}

export const GOOGLE_BUTTON: GsiButtonOptions = { theme: 'filled_black', size: 'large', text: 'signin_with', shape: 'rectangular', width: 248 }
const GSI_SRC = 'https://accounts.google.com/gsi/client'
let gsiScript: Promise<Gsi> | null = null

/** Load the Google script once, on first use; a failed load can retry later. */
export function loadGoogleIdentity(): Promise<Gsi> {
  const ready = (window as { google?: Gsi }).google
  if (ready?.accounts?.id) return Promise.resolve(ready)
  gsiScript ??= new Promise<Gsi>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = GSI_SRC
    script.async = true
    script.onload = () => {
      const gsi = (window as { google?: Gsi }).google
      if (gsi?.accounts?.id) resolve(gsi)
      else reject(new Error('Google sign-in did not load'))
    }
    script.onerror = () => reject(new Error('Google sign-in did not load'))
    document.head.appendChild(script)
  }).catch((err) => {
    gsiScript = null
    throw err
  })
  return gsiScript
}
