#!/usr/bin/env bash
# Self-test of scripts/verify-tag-signature.sh (#62, 62b). `Release: Verify`
# runs it on pull requests and dry runs, so the refusals are proven on the
# runner's git and OpenSSH, not only the tag that passes (which a release
# candidate proves).
#
# It builds a throwaway repository with two throwaway ed25519 keys, one listed
# in a throwaway allowed_signers under a label principal and one not, makes
# five tags, and checks the script's verdict and error for each. No secrets,
# no network. Run it from anywhere:
#
#   bash scripts/test-verify-tag-signature.sh
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify-tag-signature.sh"
[ -f "$script" ] || { echo "::error::self-test: $script not found"; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Keep the user's and the system's git config out (tag.gpgSign, signing keys).
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME="Self Test" GIT_AUTHOR_EMAIL="self-test@example.invalid"
export GIT_COMMITTER_NAME="Self Test" GIT_COMMITTER_EMAIL="self-test@example.invalid"

ssh-keygen -q -t ed25519 -N '' -C 'self-test: listed' -f "$tmp/listed"
ssh-keygen -q -t ed25519 -N '' -C 'self-test: unlisted' -f "$tmp/unlisted"
{
  echo "# self-test signers"
  printf 'self-test namespaces="git" %s\n' "$(cut -d' ' -f1-2 "$tmp/listed.pub")"
} > "$tmp/allowed_signers"

repo="$tmp/repo"
git init -q "$repo"
git -C "$repo" config gpg.format ssh
git -C "$repo" config user.signingkey "$tmp/listed.pub"
git -C "$repo" commit -q --allow-empty -m "self-test"

git -C "$repo" tag -s v1.0.0 -m v1.0.0                       # good
git -C "$repo" tag --no-sign v1.0.1                          # lightweight
git -C "$repo" tag --no-sign -a v1.0.2 -m v1.0.2             # unsigned annotated
git -C "$repo" -c user.signingkey="$tmp/unlisted.pub" tag -s v1.0.3 -m v1.0.3   # unlisted key
git -C "$repo" update-ref refs/tags/v1.0.4 "$(git -C "$repo" rev-parse refs/tags/v1.0.0)"   # good object, other name

failures=0
# expect TAG pass|fail [ERROR-SUBSTRING]
expect() {
  local tag="$1" want="$2" needle="${3:-}" out rc got
  # GITHUB_EVENT_NAME is cleared: the override is refused in a push run.
  out="$(cd "$repo" && env -u GITHUB_EVENT_NAME ALLOWED_SIGNERS_FILE="$tmp/allowed_signers" bash "$script" "$tag" 2>&1)" && rc=0 || rc=$?
  got=fail
  [ "$rc" -eq 0 ] && got=pass
  if [ "$got" != "$want" ]; then
    echo "::error::self-test: $tag should $want, but it did $got. Output:"
    printf '%s\n' "$out" | sed 's/^::error::/error: /; s/^/    /'
    failures=$((failures + 1))
  elif [ -n "$needle" ] && ! grep -qF -- "$needle" <<< "$out"; then
    echo "::error::self-test: $tag failed, but not with \"$needle\". Output:"
    printf '%s\n' "$out" | sed 's/^::error::/error: /; s/^/    /'
    failures=$((failures + 1))
  else
    echo "ok: $tag: $want${needle:+ (\"$needle\")}"
  fi
}

expect v1.0.0 pass
expect v1.0.1 fail "is not an annotated tag"
expect v1.0.2 fail "has no SSH signature"
expect v1.0.3 fail "is not signed by a key listed"
expect v1.0.4 fail "is named 'v1.0.0', not 'v1.0.4'"

if [ "$failures" -ne 0 ]; then
  echo "::error::self-test: $failures of 5 tag checks gave the wrong verdict. The tag signature gate can't be trusted on this runner."
  exit 1
fi
echo "Tag signature self-test passed: $(git --version), $(ssh -V 2>&1)."
