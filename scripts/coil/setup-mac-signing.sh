#!/usr/bin/env bash
#
# coil — create the macOS code-signing identity that stops the permission prompts.
#
# Issue #70. macOS keys every permission grant (Screen Recording, Accessibility, Microphone,
# Files & Folders, Local Network) to the app's DESIGNATED REQUIREMENT, which codesign derives from
# the signing certificate. With no certificate the requirement degrades to the binary's cdhash:
#
#   $ codesign -d --requirements - "/Applications/T3 Code (Alpha).app"
#   # designated => cdhash H"d48d810e7b110d8d70a793f827dd23a7b2506405"
#
# That hash changes on every build, so every update is a brand-new app to macOS and every grant is
# re-requested. Signing with a certificate — any certificate, including a self-signed one — replaces
# the hash with `identifier "com.t3tools.t3code" and certificate leaf = H"<cert>"`, which is
# identical across every rebuild. That is the whole fix: the certificate does not have to be
# TRUSTED by Apple, it has to be STABLE.
#
# What this creates:
#   ~/.t3x/mac-signing/            the certificate, its key as a .p12, and two passwords (0600)
#   ~/Library/Keychains/t3x-signing.keychain-db   a dedicated keychain holding the identity
#   an admin-domain trust setting so `security find-identity -v -p codesigning` calls it valid
#
# A dedicated keychain, not your login keychain, for one reason: its password is one we generate, so
# `security set-key-partition-list` can be run non-interactively and `codesign` never raises the
# "wants to use a key in your keychain" dialog. An unattended autobuild cannot answer a dialog.
#
# Usage:
#   scripts/coil/setup-mac-signing.sh                  # create it (idempotent), then self-verify
#   scripts/coil/setup-mac-signing.sh --status         # report; exit 0 only if usable right now
#   scripts/coil/setup-mac-signing.sh --unlock         # unlock the keychain (builds call this)
#   scripts/coil/setup-mac-signing.sh --print-identity # the CSC_NAME value
#   scripts/coil/setup-mac-signing.sh --print-requirement  # the designated requirement it produces
#   scripts/coil/setup-mac-signing.sh --print-ci-secrets   # values for the two GitHub secrets
#   scripts/coil/setup-mac-signing.sh --rotate         # NEW certificate: re-prompts once more
#
# One sudo prompt, once per machine: marking a self-signed certificate trusted for code signing is
# an admin operation. Without it `security find-identity -v -p codesigning` lists nothing and
# electron-builder silently falls back to an ad-hoc build.
#
# Env:
#   T3X_MAC_SIGNING_IDENTITY  (default: T3 Coil Code Signing) — the certificate's common name
#   T3X_MAC_SIGNING_DIR       (default: ~/.t3x/mac-signing)
#
set -euo pipefail

IDENTITY_NAME="${T3X_MAC_SIGNING_IDENTITY:-T3 Coil Code Signing}"
SIGNING_DIR="${T3X_MAC_SIGNING_DIR:-$HOME/.t3x/mac-signing}"
# `security create-keychain <name>` puts the file in ~/Library/Keychains and appends `-db`, so the
# two names below are the same keychain spelled the two ways the tool needs it.
KEYCHAIN_CREATE_NAME="${T3X_MAC_SIGNING_KEYCHAIN_NAME:-t3x-signing.keychain}"
KEYCHAIN_PATH="${T3X_MAC_SIGNING_KEYCHAIN:-$HOME/Library/Keychains/${KEYCHAIN_CREATE_NAME}-db}"
CERT_PATH="$SIGNING_DIR/t3x-signing.crt"
KEY_PATH="$SIGNING_DIR/t3x-signing.key"
P12_PATH="$SIGNING_DIR/t3x-signing.p12"
P12_PASSWORD_PATH="$SIGNING_DIR/p12-password"
KEYCHAIN_PASSWORD_PATH="$SIGNING_DIR/keychain-password"
VALIDITY_DAYS=3650
# The fork's own bundle id (issue #70), mirroring DESKTOP_BUNDLE_IDENTIFIER in
# scripts/coil/mac-signature.ts. It appears in the designated requirement, so the stub bundle signed
# by --print-requirement has to carry the SAME id as the shipped app or the recorded requirement
# would never match a real build.
BUNDLE_ID="dev.curlycloud.t3coil"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || printf '')"

MODE="ensure"
for arg in "$@"; do
  case "$arg" in
    --status) MODE="status" ;;
    --unlock) MODE="unlock" ;;
    --print-identity) MODE="print-identity" ;;
    --print-requirement) MODE="print-requirement" ;;
    --print-ci-secrets) MODE="print-ci-secrets" ;;
    --rotate) MODE="rotate" ;;
    -h|--help) sed -n '2,48p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown argument: %s (try --help)\n' "$arg" >&2; exit 2 ;;
  esac
done

log() { printf '[mac-signing] %s\n' "$*" >&2; }
die() { printf '[mac-signing] ERROR: %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "macOS only (this is where TCC lives)."

# --- primitives --------------------------------------------------------------

keychain_exists() { [[ -f "$KEYCHAIN_PATH" ]]; }

read_password() { cat "$1" 2>/dev/null || printf ''; }

unlock_keychain() {
  local password
  password="$(read_password "$KEYCHAIN_PASSWORD_PATH")"
  [[ -n "$password" ]] || return 1
  security unlock-keychain -p "$password" "$KEYCHAIN_PATH" 2>/dev/null
}

# The identity is usable only when `security find-identity -v -p codesigning` lists it: that is the
# exact command electron-builder runs (app-builder-lib/out/codeSign/macCodeSign.js, getValidIdentities),
# and -v means "valid", which for a self-signed certificate means "trusted for code signing".
identity_is_valid() {
  security find-identity -v -p codesigning "$KEYCHAIN_PATH" 2>/dev/null |
    grep -Fq "\"$IDENTITY_NAME\""
}

# electron-builder calls `security find-identity -v` with NO keychain argument, so the identity has
# to be reachable from the user's search list, not merely present in a file on disk.
keychain_in_search_list() {
  security list-keychains -d user | tr -d '"' | tr -d ' ' | grep -Fq "$KEYCHAIN_PATH"
}

add_keychain_to_search_list() {
  if keychain_in_search_list; then return 0; fi
  # `list-keychains -s` REPLACES the list, so the current entries have to be read and passed back.
  # Dropping the login keychain here would break password autofill for every app on the machine.
  local existing=()
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%\"}"
    line="${line#\"}"
    [[ -n "$line" ]] && existing+=("$line")
  done < <(security list-keychains -d user)
  log "adding to the user keychain search list: $KEYCHAIN_PATH"
  security list-keychains -d user -s "$KEYCHAIN_PATH" "${existing[@]}"
}

trust_is_set() {
  # -d is the admin domain, where `add-trusted-cert -d` writes.
  security dump-trust-settings -d 2>/dev/null | grep -Fq "$IDENTITY_NAME"
}

# --- reporting ---------------------------------------------------------------

report_status() {
  local ok=0
  if keychain_exists; then log "keychain: $KEYCHAIN_PATH"; else log "keychain: MISSING"; ok=1; fi
  if [[ -f "$CERT_PATH" ]]; then
    log "certificate: $CERT_PATH ($(openssl x509 -in "$CERT_PATH" -noout -enddate 2>/dev/null | sed 's/notAfter=/expires /'))"
  else
    log "certificate: MISSING"; ok=1
  fi
  if trust_is_set; then log "trust: set (admin domain, code signing)"; else log "trust: NOT set"; ok=1; fi
  if keychain_in_search_list; then log "search list: present"; else log "search list: absent"; ok=1; fi
  if keychain_exists && unlock_keychain; then log "unlock: ok"; else log "unlock: FAILED"; ok=1; fi
  if identity_is_valid; then
    log "identity: '$IDENTITY_NAME' is valid for code signing"
  else
    log "identity: '$IDENTITY_NAME' NOT valid for code signing"; ok=1
  fi
  return "$ok"
}

# Sign a throwaway bundle carrying the real bundle id and report the requirement it produces.
#
# This is how the designated requirement can be recorded WITHOUT a 470 MB desktop build: the
# requirement is a function of exactly two things — the signing identifier and the certificate —
# and a four-file stub bundle has both. The string this prints is byte-for-byte what the shipped
# .app gets, which is what makes docs/coil/mac-signing/designated-requirement.txt trustworthy.
print_requirement() {
  identity_is_valid || die "identity '$IDENTITY_NAME' is not usable yet; run this script with no arguments first."
  unlock_keychain || die "could not unlock $KEYCHAIN_PATH"

  local stub
  stub="$(mktemp -d "${TMPDIR:-/tmp}/coil-sig-stub.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf '$stub'" RETURN

  mkdir -p "$stub/Stub.app/Contents/MacOS" "$stub/Stub.app/Contents/Resources"
  # A copied system binary, so this works on a machine with no compiler installed.
  cp /usr/bin/true "$stub/Stub.app/Contents/MacOS/stub"
  /usr/libexec/PlistBuddy \
    -c "Add :CFBundleIdentifier string $BUNDLE_ID" \
    -c "Add :CFBundleExecutable string stub" \
    -c "Add :CFBundleName string Stub" \
    -c "Add :CFBundlePackageType string APPL" \
    "$stub/Stub.app/Contents/Info.plist" >/dev/null

  codesign --force --sign "$IDENTITY_NAME" --keychain "$KEYCHAIN_PATH" \
    --identifier "$BUNDLE_ID" --options runtime --timestamp=none "$stub/Stub.app" >/dev/null 2>&1 ||
    die "codesign failed with identity '$IDENTITY_NAME'"

  codesign -d --requirements - "$stub/Stub.app" 2>&1 |
    sed -n 's/^ *designated => //p'
}

print_ci_secrets() {
  [[ -f "$P12_PATH" ]] || die "no p12 at $P12_PATH; run this script with no arguments first."
  cat <<EOF
Two repository secrets. The .p12 holds the PRIVATE KEY — set them with gh, never paste them into a
file in the repo:

  gh secret set T3X_MAC_CSC_P12_BASE64 -R radroid/t3code < "$SIGNING_DIR/t3x-signing.p12.base64"
  gh secret set T3X_MAC_CSC_PASSWORD   -R radroid/t3code --body "\$(cat '$P12_PASSWORD_PATH')"

EOF
  base64 < "$P12_PATH" > "$P12_PATH.base64"
  chmod 600 "$P12_PATH.base64"
  log "wrote $P12_PATH.base64"
}

# --- creation ----------------------------------------------------------------

create_identity() {
  mkdir -p "$SIGNING_DIR"
  chmod 700 "$SIGNING_DIR"

  local keychain_password p12_password
  if [[ ! -f "$KEYCHAIN_PASSWORD_PATH" ]]; then
    openssl rand -base64 24 | tr -d '\n' > "$KEYCHAIN_PASSWORD_PATH"
    chmod 600 "$KEYCHAIN_PASSWORD_PATH"
  fi
  if [[ ! -f "$P12_PASSWORD_PATH" ]]; then
    openssl rand -base64 24 | tr -d '\n' > "$P12_PASSWORD_PATH"
    chmod 600 "$P12_PASSWORD_PATH"
  fi
  keychain_password="$(read_password "$KEYCHAIN_PASSWORD_PATH")"
  p12_password="$(read_password "$P12_PASSWORD_PATH")"

  if [[ ! -f "$CERT_PATH" || ! -f "$KEY_PATH" ]]; then
    log "creating a $VALIDITY_DAYS-day self-signed code-signing certificate: $IDENTITY_NAME"
    local config
    config="$(mktemp "${TMPDIR:-/tmp}/coil-openssl.XXXXXX")"
    # A config file rather than `-addext`, which LibreSSL — what /usr/bin/openssl is on a stock
    # macOS — does not accept.
    cat > "$config" <<EOF
[ req ]
distinguished_name = dn
x509_extensions = code_signing
prompt = no

[ dn ]
CN = $IDENTITY_NAME

[ code_signing ]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
EOF
    openssl req -x509 -newkey rsa:2048 -sha256 -days "$VALIDITY_DAYS" -nodes \
      -keyout "$KEY_PATH" -out "$CERT_PATH" -config "$config" 2>/dev/null
    rm -f "$config"
    chmod 600 "$KEY_PATH"
  fi

  if [[ ! -f "$P12_PATH" ]]; then
    # PBE-SHA1-3DES and -macalg sha1 are load-bearing. OpenSSL 3 defaults to AES-256-CBC with a
    # SHA-256 MAC, which macOS `security import` rejects with the misleading
    # "MAC verification failed during PKCS12 import (wrong password?)" — the password is fine, the
    # algorithm is not.
    openssl pkcs12 -export -inkey "$KEY_PATH" -in "$CERT_PATH" -out "$P12_PATH" \
      -name "$IDENTITY_NAME" -passout "pass:$p12_password" \
      -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
    chmod 600 "$P12_PATH"
  fi

  if ! keychain_exists; then
    log "creating keychain $KEYCHAIN_PATH"
    security create-keychain -p "$keychain_password" "$KEYCHAIN_CREATE_NAME"
    # No -t: a keychain that auto-locks after N seconds of idleness makes an overnight autobuild
    # fail with "no identity found" for no visible reason.
    security set-keychain-settings "$KEYCHAIN_PATH"
  fi
  unlock_keychain || die "could not unlock $KEYCHAIN_PATH"

  if ! security find-certificate -c "$IDENTITY_NAME" "$KEYCHAIN_PATH" >/dev/null 2>&1; then
    log "importing the identity"
    security import "$P12_PATH" -k "$KEYCHAIN_PATH" -P "$p12_password" \
      -T /usr/bin/codesign -T /usr/bin/security
    # Without this, codesign gets a GUI keychain-access prompt instead of the key, even though
    # -T named it above. macOS 10.12 split the two.
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s \
      -k "$keychain_password" "$KEYCHAIN_PATH" >/dev/null
  fi

  add_keychain_to_search_list

  if ! trust_is_set; then
    # The one privileged step: a self-signed certificate is not "valid for code signing" until it is
    # trusted, and `security find-identity -v -p codesigning` — the command electron-builder asks —
    # lists nothing without it. Never prompt blindly: `sudo` with no terminal to answer on hangs,
    # and this script is called from unattended builds and from agents.
    if sudo -n true 2>/dev/null || [[ -t 0 ]]; then
      log "marking the certificate trusted for code signing (sudo may ask for your password)"
      sudo security add-trusted-cert -d -r trustRoot -p codeSign \
        -k /Library/Keychains/System.keychain "$CERT_PATH"
    else
      log "the certificate exists but is not trusted yet, and there is no terminal here to ask for"
      log "sudo on. Run this one command, then re-run this script:"
      log ""
      log "  sudo security add-trusted-cert -d -r trustRoot -p codeSign \\"
      log "    -k /Library/Keychains/System.keychain '$CERT_PATH'"
      log ""
      die "trust step not completed"
    fi
  fi

  identity_is_valid ||
    die "the identity still is not valid for code signing. Check: security find-identity -v -p codesigning '$KEYCHAIN_PATH'"

  log "identity ready: $IDENTITY_NAME"
}

# --- modes -------------------------------------------------------------------

case "$MODE" in
  status)
    report_status
    ;;
  unlock)
    unlock_keychain || die "could not unlock $KEYCHAIN_PATH (has the identity been created?)"
    ;;
  print-identity)
    printf '%s\n' "$IDENTITY_NAME"
    ;;
  print-requirement)
    print_requirement
    ;;
  print-ci-secrets)
    print_ci_secrets
    ;;
  rotate)
    log "ROTATING the signing identity. Every macOS permission will be asked for ONE more time"
    log "after the next build installs, because the designated requirement changes with the"
    log "certificate. Ctrl-C now if that is not what you want."
    sleep 5
    security delete-keychain "$KEYCHAIN_PATH" 2>/dev/null || true
    rm -f "$CERT_PATH" "$KEY_PATH" "$P12_PATH" "$P12_PATH.base64"
    create_identity
    log "new designated requirement: $(print_requirement)"
    log "Record it: scripts/coil/setup-mac-signing.sh --print-requirement > docs/coil/mac-signing/designated-requirement.txt"
    log "And re-set the CI secrets: scripts/coil/setup-mac-signing.sh --print-ci-secrets"
    ;;
  ensure)
    create_identity
    requirement="$(print_requirement)"
    log "designated requirement: $requirement"
    if [[ -n "$REPO" ]]; then
      recorded="$REPO/docs/coil/mac-signing/designated-requirement.txt"
      if [[ -f "$recorded" ]] && [[ "$(tr -d '\n' < "$recorded")" != "$requirement" ]]; then
        log "WARNING: this differs from the recorded requirement in"
        log "  $recorded"
        log "  recorded: $(tr -d '\n' < "$recorded")"
        log "A release signed with this identity would re-request every permission once."
      fi
    fi
    log ""
    log "Next: builds pick the identity up through CSC_NAME. scripts/coil/auto-build-desktop.sh does"
    log "that on its own; the release workflow needs the two secrets from --print-ci-secrets."
    ;;
esac
