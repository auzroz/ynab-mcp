#!/usr/bin/env bash
# Release gate, tag signatures (#62, decision D-2). `Release: Verify` runs it.
#
#   scripts/verify-tag-signature.sh          check that .github/allowed_signers parses
#   scripts/verify-tag-signature.sh vX.Y.Z   that check, then verify the tag's signature
#
# A release tag must be an annotated tag signed with an SSH key listed in
# .github/allowed_signers. The tag object must already be in the local
# repository: release.yml fetches it before running this.
#
# ALLOWED_SIGNERS_FILE overrides the path (default .github/allowed_signers),
# for testing. Run it from the repository root.
set -euo pipefail

signers="${ALLOWED_SIGNERS_FILE:-.github/allowed_signers}"
tag="${1:-}"

fail() {
  echo "::error::$*"
  exit 1
}

[ -f "$signers" ] || fail "$signers is missing. It lists the SSH keys allowed to sign release tags."

# 1. The file parses. ssh-keygen skips a malformed line with a warning on
# stderr ("file:N: invalid key") and carries on, so a typo would only show up
# as a refused tag. Append a throwaway key to a copy of the file and look it up
# with a signature made by that key: ssh-keygen reads every line before it
# reaches the last one, so any warning means a bad line, and finding the
# throwaway principal means the file is usable.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
ssh-keygen -q -t ed25519 -N '' -C 'release-gate-probe' -f "$tmp/probe"
printf 'release gate probe\n' > "$tmp/message"
ssh-keygen -q -Y sign -f "$tmp/probe" -n git "$tmp/message" 2> "$tmp/sign.err" \
  || { cat "$tmp/sign.err"; fail "could not make the probe signature"; }
cp "$signers" "$tmp/allowed_signers"
# The leading newline ends a last line that has none; it adds no line before it.
printf '\nrelease-gate-probe namespaces="git" %s\n' "$(cut -d' ' -f1-2 "$tmp/probe.pub")" >> "$tmp/allowed_signers"
found="$(ssh-keygen -Y find-principals -f "$tmp/allowed_signers" -s "$tmp/message.sig" 2> "$tmp/find.err" || true)"
if [ -s "$tmp/find.err" ] || [ "$found" != "release-gate-probe" ]; then
  # Report the warnings against the real file name; the line numbers match.
  sed "s#^$tmp/allowed_signers:#$signers:#" "$tmp/find.err"
  fail "$signers does not parse (see the lines above). Each entry is: principal namespaces=\"git\" key-type base64-key"
fi

# Every entry must allow the "git" namespace, or verify-tag refuses its tags
# with "key is not permitted for use in signature namespace". The namespaces
# option is a comma-separated pattern list, read as OpenSSH reads it: * and ?
# are wildcards, and a matching !pattern excludes the namespace whatever else
# matches.
allows_git() {
  local item allowed=1
  local -a items
  IFS=',' read -r -a items <<< "$1"
  for item in "${items[@]}"; do
    if [[ "$item" == '!'* ]]; then
      # shellcheck disable=SC2053 # the right-hand side is a pattern on purpose
      [[ git == ${item#!} ]] && return 1
    else
      # shellcheck disable=SC2053
      [[ git == $item ]] && allowed=0
    fi
  done
  return "$allowed"
}
entries=0
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  trimmed="${line#"${line%%[![:space:]]*}"}"
  case "$trimmed" in '' | '#'*) continue ;; esac
  entries=$((entries + 1))
  if [[ "$trimmed" =~ namespaces=\"([^\"]*)\" ]] && ! allows_git "${BASH_REMATCH[1]}"; then
    fail "$signers: entry ${entries}'s namespaces option doesn't allow \"git\", so it can't verify a tag."
  fi
done < "$signers"

if [ -z "$tag" ]; then
  if [ "$entries" -eq 0 ]; then
    echo "::warning::$signers parses but lists no key yet. Every v* tag fails Release: Verify until the maintainer adds theirs (CONTRIBUTING.md, \"Releases\")."
  else
    echo "$signers parses: $entries key(s)."
  fi
  exit 0
fi

# 2. The tag.
if [ "$entries" -eq 0 ]; then
  fail "$signers lists no signing key yet, so no tag can be verified. The maintainer adds their SSH public key there first (CONTRIBUTING.md, \"Settings the gate relies on\")."
fi

ref="refs/tags/$tag"
type="$(git cat-file -t "$ref" 2> /dev/null || true)"
if [ "$type" != "tag" ]; then
  fail "$tag is not an annotated tag (its ref points at a ${type:-missing} object). Release tags are signed: git tag -s $tag -m $tag <sha>."
fi

# A signed tag object can be pushed again under another ref name. Its own name
# must be the one being released.
name="$(git for-each-ref --format='%(tag)' "$ref")"
if [ "$name" != "$tag" ]; then
  fail "the tag object at $ref is named '$name', not '$tag'."
fi

# Read the object first: grep -q exits on the first match, and a writer still
# writing would then fail the pipeline under pipefail.
object="$(git cat-file tag "$ref")"
if ! grep -qx -- '-----BEGIN SSH SIGNATURE-----' <<< "$object"; then
  fail "$tag has no SSH signature. Release tags are signed with an SSH key (git config gpg.format ssh) listed in $signers."
fi

# Decide on the exit status only: verify-tag prints 'Good "git" signature'
# for a valid signature by an unlisted key too, then "No principal matched"
# and exits 1. gpg.minTrustLevel=fully also refuses that case on any git
# version: git gives a signature trust level "fully" only when a principal in
# the file matched.
if ! git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile="$signers" -c gpg.minTrustLevel=fully verify-tag "$tag"; then
  fail "$tag is not signed by a key listed in $signers. Refusing to release."
fi
echo "$tag is an annotated tag signed by a key listed in $signers."
