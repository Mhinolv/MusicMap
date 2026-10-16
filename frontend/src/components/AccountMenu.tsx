import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { ACCOUNT_MENU_ID, accountAriaLabel, accountLabel, GOOGLE_BUTTON, loadGoogleIdentity, SIGN_IN_ERROR } from '../account'
import type { AuthConfig, AuthUser } from '../types'
import type { SyncStatus } from '../tasteSync'
import { SyncStatusLine } from './SyncStatusLine'

type ButtonProps = {
  user: AuthUser | null
  open: boolean
  onToggle: () => void
  buttonRef: RefObject<HTMLButtonElement | null>
  className?: string
  icon?: boolean
}

/** Header entry (#75): `Sign in`, or the first name once signed in. Phones get a person glyph. */
export function AccountButton({ user, open, onToggle, buttonRef, className = '', icon = false }: ButtonProps) {
  const shared = { ref: buttonRef, type: 'button' as const, 'aria-expanded': open, 'aria-controls': ACCOUNT_MENU_ID, onClick: onToggle }
  if (icon) return (
    <button {...shared} className={`account-button account-button--icon ${className}`} aria-label={accountAriaLabel(user)}>
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square">
        <circle cx="12" cy="8" r="4" /><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" />
      </svg>
    </button>
  )
  return (
    <button {...shared} className={`taste-entry account-button ${className}`} aria-label={user ? accountAriaLabel(user) : undefined}>
      {accountLabel(user)}
    </button>
  )
}

type Props = {
  user: AuthUser | null
  config: AuthConfig
  /** Taste sync state, shown under the email while signed in (#76). */
  syncStatus: SyncStatus
  anchor: RefObject<HTMLButtonElement | null>
  /** Resolves once signed in; rejects to show the error state. No credential means mock sign-in. */
  onSignIn: (credential?: string) => Promise<void>
  onSignOut: () => void
  /** `refocus` is false for an outside click, so focus stays where the user clicked. */
  onClose: (refocus: boolean) => void
}

/** Non-modal account popover under its header button. */
export function AccountMenu({ user, config, syncStatus, anchor, onSignIn, onSignOut, onClose }: Props) {
  const menu = useRef<HTMLElement>(null)
  const googleSlot = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<'idle' | 'pending' | 'error'>('idle')
  const [place, setPlace] = useState<{ top: number; right: number }>()
  const signIn = useRef(onSignIn)
  signIn.current = onSignIn

  const run = (credential?: string) => {
    setPhase('pending')
    signIn.current(credential).then(() => setPhase('idle'), () => setPhase('error'))
  }
  const runRef = useRef(run)
  runRef.current = run

  useLayoutEffect(() => {
    const measure = () => {
      const rect = anchor.current?.getBoundingClientRect()
      if (rect) setPlace({ top: Math.round(rect.bottom + 4), right: Math.max(0, Math.round(window.innerWidth - rect.right)) })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [anchor])

  // #87: publish the popover height so the phone start column can move below it.
  useLayoutEffect(() => {
    const el = menu.current
    const host = el?.parentElement
    if (!el || !host) return
    const publish = () => host.style.setProperty('--account-menu-h',`${Math.ceil(el.offsetHeight)}px`)
    publish()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(publish)
    observer?.observe(el)
    return () => {
      observer?.disconnect()
      host.style.removeProperty('--account-menu-h')
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('[aria-modal="true"]')) return
      e.preventDefault()
      onClose(true)
    }
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node
      if (menu.current?.contains(target) || anchor.current?.contains(target)) return
      onClose(false)
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [anchor, onClose])

  const google = !user && !config.mock && !!config.google_client_id
  useEffect(() => {
    if (!google) return
    let live = true
    loadGoogleIdentity().then((gsi) => {
      if (!live || !googleSlot.current) return
      gsi.accounts.id.initialize({
        client_id: config.google_client_id,
        callback: (response) => {
          if (response.credential) runRef.current(response.credential)
          else setPhase('error')
        },
      })
      gsi.accounts.id.renderButton(googleSlot.current, GOOGLE_BUTTON)
    }, () => { if (live) setPhase('error') })
    return () => { live = false }
  }, [google, config.google_client_id])

  return (
    <section ref={menu} id={ACCOUNT_MENU_ID} className="account-menu" aria-label="Account"
      style={place ? { top: place.top, right: place.right } : undefined}>
      {user ? (
        <>
          <div className="account-menu__who">
            <p className="account-menu__name">{user.name || user.email}</p>
            {user.email && <p className="account-menu__email">{user.email}</p>}
            <SyncStatusLine status={syncStatus} />
          </div>
          <button type="button" className="btn account-menu__signout" onClick={onSignOut}>Sign out</button>
        </>
      ) : (
        <>
          <p className="account-menu__text">Sign in to keep your taste and recent maps on every device. Everything works without an account.</p>
          {config.mock
            ? <button type="button" className="btn btn--primary account-menu__mock" hidden={phase === 'pending'} onClick={() => run()}>Sign in (mock)</button>
            : <div ref={googleSlot} className="account-menu__google" hidden={phase === 'pending'} />}
          {phase === 'pending' && <p className="account-menu__status" role="status">Signing in…</p>}
          {phase === 'error' && <p className="panel__error account-menu__error" role="alert">{SIGN_IN_ERROR}</p>}
        </>
      )}
    </section>
  )
}
