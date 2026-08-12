# t3x — macOS code signing, or: why the app stopped asking for permissions

Issue #70. Every update used to re-ask for Screen Recording, Accessibility, Microphone, Files &
Folders and Local Network. That was not the updater misbehaving and not a quarantine problem — it
was code signing, and the fix cost $0.

**One upstream line, and not the one the issue predicted.** The signing half needs no upstream edit at
all — see [Why signing needed no upstream edit](#why-signing-needed-no-upstream-edit). The second half
(a bundle id of the fork's own, below) spends exactly one line in `scripts/build-desktop-artifact.ts`,
recorded as `SEAMS.md`'s 38th row. Everything else lives in `scripts/coil/`,
`.github/workflows/t3x-release.yml` and this directory.

## The diagnosis, in two commands

macOS stores each permission grant against the app's **designated requirement**, a code-signing
predicate it re-evaluates on every access. Compare the fork's build before this landed with
upstream's official one, both installed at the same time:

```
$ codesign -d --requirements - "/Applications/T3 Code (Alpha).app"      # the fork, before
# designated => cdhash H"d48d810e7b110d8d70a793f827dd23a7b2506405"

$ codesign -d --requirements - "/Applications/T3 Code (Nightly).app"    # upstream
designated => identifier "com.t3tools.t3code" and anchor apple generic
  and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13]
  and certificate leaf[subject.OU] = ARK85ZXQ4Z
```

With no certificate to name, codesign falls back to the binary's `cdhash` — which changes when any
byte of the app changes. So every build was a different app as far as macOS was concerned, and every
grant was void on arrival. Upstream's requirement names a certificate instead, and survives.

The fix is therefore **not** "sign the app". It is "sign it with an identity that does not move". The
certificate does not need to be trusted by Apple; it needs to be the same one next time.

## The identity

A self-signed code-signing certificate, created by `scripts/coil/setup-mac-signing.sh`:

|                       |                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| Common name           | `T3 Coil Code Signing`                                                                                     |
| Validity              | 10 years (`notAfter=Aug 8 2036`)                                                                           |
| Public certificate    | [`docs/coil/mac-signing/certificate.pem`](mac-signing/certificate.pem), committed                          |
| Private key           | `~/.t3x/mac-signing/t3x-signing.p12`, mode 0600, never in the repo                                         |
| Keychain              | `~/Library/Keychains/t3x-signing.keychain-db`, its own, password in `~/.t3x/mac-signing/keychain-password` |
| Resulting requirement | [`docs/coil/mac-signing/designated-requirement.txt`](mac-signing/designated-requirement.txt)               |

A dedicated keychain rather than the login keychain, because its password is one we generate: that is
what lets `security set-key-partition-list` run non-interactively, so `codesign` never raises the
"wants to use a key in your keychain" dialog. An unattended 3am autobuild cannot click a dialog.

Not the $99 Developer Program, and not the `Apple Development` certificate already in this Mac's
keychain. Either would also work — the requirement is stable in all three cases — but a self-signed
certificate is purpose-built (no relation to an Apple ID), lasts ten years instead of one, and does
not print the owner's email address into every shipped artifact's signature.

## One-time setup

On the machine that owns the identity:

```bash
scripts/coil/setup-mac-signing.sh
```

It is idempotent, and it self-verifies: it signs a throwaway bundle at the end and refuses to report
success unless `security find-identity -v -p codesigning` lists the identity. One step needs
`sudo` — marking a self-signed certificate trusted for code signing is an admin operation, and
**without it the certificate is invisible to electron-builder**, which then silently produces an
ad-hoc build. If the script is running somewhere with no terminal to answer on, it prints the exact
command and stops rather than hanging on a `sudo` prompt.

Expect `security find-identity -v -p codesigning` to list `T3 Coil Code Signing` **twice** afterwards, with
the same SHA-1 both times: `add-trusted-cert -k /Library/Keychains/System.keychain` copies the
certificate into the System keychain as well as trusting it, so it is visible from two keychains at
once. Verified harmless — `codesign -s "T3 Coil Code Signing"` with no `--keychain` (which is exactly how
electron-builder signs) resolves it, signs, and produces the expected requirement. Two entries for two
_different_ certificates of the same name would be a real problem; two for one certificate is not.

Then the release workflow needs the private key, as two repository secrets:

```bash
scripts/coil/setup-mac-signing.sh --print-ci-secrets   # writes the base64 and prints both commands
```

| Secret                   | Value                                            |
| ------------------------ | ------------------------------------------------ |
| `T3X_MAC_CSC_P12_BASE64` | `base64` of `~/.t3x/mac-signing/t3x-signing.p12` |
| `T3X_MAC_CSC_PASSWORD`   | contents of `~/.t3x/mac-signing/p12-password`    |

With them absent the release still succeeds — it just warns and ships an ad-hoc build, which is the
pre-#70 behaviour. That is deliberate: a missing secret should not be able to block a release, only
to downgrade it, and the warning plus the verify step make the downgrade visible.

## What to expect on the first signed build

**Every permission is asked for one more time.** The identity is moving from "cdhash" to "our
certificate", which is a change like any other, so the existing grants do not match and macOS asks
again. Grant them once. From then on they stick across every update.

This matters because that first install looks _exactly_ like the bug it fixes. Do not conclude the
fix failed until the **second** signed build installs without prompting.

## Verifying a build

```bash
node scripts/coil/verify-mac-signature.ts --artifact release/T3-Code-*.dmg \
  --expect-requirement-file docs/coil/mac-signing/designated-requirement.txt
```

It mounts the dmg read-only, inspects the `.app` that actually ships, and fails on any of: an ad-hoc
signature, a cdhash-keyed requirement, the wrong bundle id, an unsealed resource envelope, an unbound
`Info.plist`, a failed `codesign --verify --deep --strict`, or a requirement that differs from the
recorded one.

That last case is the one worth having a file for. A build signed by a _different_ valid certificate
is perfectly signed and still costs the user every dialog once, so "is it signed?" is not a strong
enough question — "is it signed by the same thing as last time?" is. Both the release workflow and
`scripts/coil/auto-build-desktop.sh` run this check, and the autobuild refuses to install a build
that fails it.

`spctl -a -vvv` will still reject the app: it is not notarized. That is expected and unrelated —
see below.

## What this does not fix

**Gatekeeper on a freshly downloaded copy.** The app is signed but not notarized, so a download from
the releases page still hits the unidentified-developer wall. The update path is unaffected: the
updater strips `com.apple.quarantine` from both the dmg and the staged app
(`apps/desktop/src/coil/updateDelivery/installCommands.ts`). Notarization needs the paid Developer
Program; this does not.

**Anyone else's Mac.** The private key lives on one machine and in this repo's secrets. A different
person building this fork gets their own identity, hence their own prompts, once.

**Windows installs made before this.** `appId` is also the NSIS product identity, so the first
Windows build after the bundle id changed installs alongside the old one instead of upgrading it.
Uninstall the old entry by hand once. macOS is unaffected: the updater targets the `.app` by name,
and the name did not change.

## The second cause: a bundle id shared with upstream

Stable signing was necessary but not sufficient, because both apps used to report the same bundle id:

```
$ mdls -name kMDItemCFBundleIdentifier "/Applications/T3 Code (Alpha).app" \
       "/Applications/T3 Code (Nightly).app"
com.t3tools.t3code
com.t3tools.t3code
```

macOS stores **one TCC row per `(service, client)`**, where `client` is that bundle id. Two apps with
one id share one row per permission, so whichever launched most recently owned the grant and the other
was re-prompted — no matter how perfectly either was signed. Anyone running the fork's build next to
upstream's nightly was getting dialogs from this even with a stable certificate.

So the fork now has its own: **`dev.curlycloud.t3coil`**, after `coil` (coil.curlycloud.dev). Set
through `T3X_DESKTOP_APP_ID`, which is the one upstream-owned line this whole change spends —
`DESKTOP_APP_ID` in `scripts/build-desktop-artifact.ts` reads it and falls back to upstream's value,
so upstream's own assertions on that constant still pass and an unset environment builds exactly what
upstream builds. See `SEAMS.md`.

One deliberate non-change, and one that has since changed:

- **User data does not move.** `~/Library/Application Support/t3code` comes from a hardcoded
  `userDataDirName`, not from the bundle id or the app name — threads, settings and sessions are
  untouched. This held through #70 and again through #71.
- **`productName` no longer stays `T3 Code (Alpha)`.** It became `T3 Coil (Alpha)` in #71, along
  with the bundle id (`dev.curlycloud.t3coil`) and the certificate (`T3 Coil Code Signing`). The
  hazard this note used to warn about is real and was accepted rather than avoided: the updater
  refuses an install when the `.app` name in the dmg differs from the installed one, so the first
  renamed build has to be installed by hand, once. `describeRefusal` says exactly that now instead
  of reading like a fault.

Since it lands in the same release as the signing change, the two identity changes cost **one**
round of prompts between them, not two. `scripts/coil/mac-signature.test.ts` asserts every build path
sets the variable and that the recorded requirement names this id, because a forgotten variable or a
sync that reverts the seam would silently put the fork back to sharing upstream's row.

## Why signing needed no upstream edit

`scripts/build-desktop-artifact.ts:1996` sets `CSC_IDENTITY_AUTO_DISCOVERY=false` whenever `--signed`
is absent, and issue #70's plan concluded from that a third signing mode had to be added to the file.
It does not: the flag is only consulted when **no identity was named**.

```js
// app-builder-lib/out/codeSign/macCodeSign.js
function findIdentity(certType, qualifier, keychain) {
  let identity = qualifier || process.env.CSC_NAME;
  if (isEmptyOrSpaces(identity)) {
    if (isAutoDiscoveryCodeSignIdentity()) return _findIdentity(certType, null, keychain);
    else return Promise.resolve(null); // <- the only place the flag applies
  }
  return _findIdentity(certType, identity.trim(), keychain);
}
```

So exporting `CSC_NAME` around the existing unsigned build is enough, and the fork keeps its
zero-seam property. Two things follow, both load-bearing:

- **An empty `CSC_NAME` is the same as no `CSC_NAME`.** A machine or a CI job without the identity
  behaves exactly as before, which is why this is safe to wire in unconditionally.
- **Do not "simplify" it to `--signed`.** That flag takes the macOS passkey path, which requires
  `T3CODE_CLERK_PUBLISHABLE_KEY` / `T3CODE_CLERK_PASSKEY_RP_DOMAINS` and a provisioning profile, and
  turns on notarization expectations a self-signed certificate cannot satisfy.

`type` is left at electron-builder's default (`distribution`), which looks for
`Developer ID Application` and then falls back to "any non-Apple certificate" — the branch our
self-signed identity is found by. Nothing about the mac build config changes.

**Hardened runtime comes along with signing**, since electron-builder enables it for every non-MAS
signed build (`hardenedRuntime !== false`), and the app is signed with its default entitlements:
`allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`. That set is not a
guess — it is byte-identical to the runtime entitlements upstream uses for its own notarized builds
(`renderMacPasskeyEntitlements` in `scripts/build-desktop-artifact.ts`, minus the passkey keys), so a
signed fork build runs under the same restrictions as the `T3 Code (Nightly)` many people already
use. `disable-library-validation` in particular is what keeps the bundled native modules loadable.

## Rotating the certificate

Only if the key leaks or the certificate expires (2036). It costs one round of prompts:

```bash
scripts/coil/setup-mac-signing.sh --rotate
scripts/coil/setup-mac-signing.sh --print-requirement > docs/coil/mac-signing/designated-requirement.txt
cp ~/.t3x/mac-signing/t3x-signing.crt docs/coil/mac-signing/certificate.pem
scripts/coil/setup-mac-signing.sh --print-ci-secrets     # then re-set both secrets
```

Commit the two files in the same change. The verify step compares against the recorded requirement,
so a rotation that forgets them fails the next release instead of quietly re-prompting the user.

## Related

- **Issue #71 — renaming the fork to `coil`.** Done. It moved all three identities at once — bundle
  id, certificate and visible name — deliberately, so the permission reset is paid once rather than
  once per change. The certificate rename is the half that is not a code change: a new common name
  is a new certificate, so `--rotate` has to run and `designated-requirement.txt` has to be
  re-recorded from it before the release can sign anything. Renaming the visible app is free in TCC
  terms — grants key on the designated requirement, which names the bundle id and the certificate,
  not `productName`.
- `docs/coil/auto-build-runbook.md` — the local build/install loop, which signs the same way.
- Issue #41 — the autobuild relaunch race. Unrelated, adjacent.
- Issue #72 / PR #78 (still open, branch `t3x/install-instructions`) — the first-launch install copy,
  written against the _current_ Gatekeeper verdict for a downloaded build ("damaged"). A valid
  signature may well downgrade that to the ordinary unidentified-developer dialog, in which case the
  strings in that PR's `scripts/coil/install-instructions.json` want revisiting — the test that pins
  the wording is what will say so. Unverified here on purpose: the update path never shows that
  dialog, so nothing in this change has been able to observe it.
