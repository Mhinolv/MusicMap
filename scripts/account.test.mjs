// Account labels for the optional sign-in control (#75); no browser or GUI.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const ts = require('typescript')
const source = readFileSync(new URL('../frontend/src/account.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const a = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

const user = (name, email = 'ada@example.com') => ({ id: '1', name, email })

test('signed out shows Sign in in the label and the phone aria-label', () => {
  assert.equal(a.accountLabel(null), 'Sign in')
  assert.equal(a.accountAriaLabel(null), 'Sign in')
})

test('signed in shows the first name, cut to 12 characters', () => {
  assert.equal(a.accountLabel(user('Ada Lovelace')), 'Ada')
  assert.equal(a.accountLabel(user('  Ada   Lovelace ')), 'Ada')
  assert.equal(a.accountLabel(user('Bartholomew-Alexander Smith')), 'Bartholomew-')
  assert.equal(a.accountLabel(user('Bartholomew-Alexander')).length, 12)
  assert.equal(a.accountLabel(user('Twelve_chars')), 'Twelve_chars')
  // Code points, not UTF-16 units: a cut never splits a character.
  assert.equal(a.accountLabel(user('😀'.repeat(14))), '😀'.repeat(12))
})

test('a missing name falls back to the email, then to Account', () => {
  assert.equal(a.accountLabel(user('', 'listener@example.com')), 'listener')
  assert.equal(a.accountLabel(user('   ', '')), 'Account')
})

test('aria-label and toast name the whole account', () => {
  assert.equal(a.accountAriaLabel(user('Ada Lovelace')), 'Account, signed in as Ada Lovelace')
  assert.equal(a.accountAriaLabel(user('', 'ada@example.com')), 'Account, signed in as ada@example.com')
  assert.equal(a.signedInToast(user('Ada Lovelace')), 'Signed in as Ada Lovelace.')
  // #79 Orchestrator decision: the final sign-out toast.
  assert.equal(a.SIGNED_OUT_TOAST, 'Signed out. Your taste, maps and Library stay in your account.')
})

test('the Google button uses the design-note options', () => {
  assert.deepEqual(a.GOOGLE_BUTTON, { theme: 'filled_black', size: 'large', text: 'signin_with', shape: 'rectangular', width: 248 })
  assert.equal(a.ACCOUNT_MENU_ID, 'account-menu')
  assert.equal(a.SIGN_IN_ERROR, "Couldn't sign in. Try again.")
})
