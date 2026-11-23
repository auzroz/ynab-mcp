# Release workflow rehearsal (scratch repository)

This runs the tag path of `.github/workflows/release.yml` end to end in a public
scratch repository, so the first gated release of `auzroz/ynab-mcp` is not also
the first time the workflow runs. It takes about an hour, most of it waiting for
the image builds.

**Optional since 0.5.0.** The maintainer proves the tag path with a release
candidate instead (`v0.5.0-rc.1`, CONTRIBUTING.md "Release candidates"). It
covers check 2 for real, and check 3 when section 4's commands are run against
the candidate (`SCRATCH=auzroz/ynab-mcp`, without the negative check). It
publishes npm under `next` instead of check 4's dry run. The `v*`
tag ruleset now restricts tag creation to the maintainer, which covers most of
check 1's ancestry part. A candidate proves only that a good signature passes.
The signature refusals of check 1 are also proven, without a tag push, by
`scripts/test-verify-tag-signature.sh`, which `Release: Verify` runs on every
pull request and dry run; only the scratch repo runs them as real tag pushes.
The admin checklist below
still applies. The scratch-repo steps remain for a tag-path change that should
be tried without publishing anything, such as 62b (#62).

The rehearsal proves four things (plan gate G16b, and 62b of #62):

1. **Ancestry and signature checks.** `Release: Verify` refuses each of these
   before any job asks for an approval: a signed tag on a commit that is not
   on `main` or a `release/*` branch; a lightweight tag, an unsigned annotated
   tag, and a tag signed by a key that is not in `.github/allowed_signers`,
   each on `main`.
2. **Two approvals.** A signed tag on a commit on `main` stops twice for a
   `production` approval: first `Release: Publish image`, which pushes with
   the `GHCR_PUSH_TOKEN` environment secret, then `Release: Publish npm`.
3. **Attestations.** These verify with `gh attestation verify`: build
   provenance on every file in `SHA256SUMS` (the npm tarball, its SBOM and the
   skills zips), an SBOM attestation on the npm tarball, and provenance and an
   SBOM attestation on the image. The skills zips have provenance only.
   `SHA256SUMS` matches the release files.
4. **npm stays dry.** Outside `auzroz/ynab-mcp`, the npm step runs
   `npm publish --dry-run`. Nothing reaches npmjs.com.

Run it from your own terminal and your own `gh` login (not an agent token). It
never touches `auzroz/ynab-mcp`, npm, a YNAB token or a database.

The admin checklist for `auzroz/ynab-mcp` itself comes first. The release gate
in `release.yml` depends on those settings (CONTRIBUTING.md, "Settings the gate
relies on").

## Admin checklist (auzroz/ynab-mcp)

The maintainer does these in this order, from their own login. Agents can't
and must not. Each step ends with a read-only check.

### 1. Wed Nov 4: `release/**` branch ruleset

Settings → Rules → Rulesets → New ruleset → New branch ruleset:

- **Ruleset name** `release branches`, **Enforcement status** Active;
- **Bypass list** → Add bypass → Repository admin, mode **Always allow**;
- **Target branches** → Add target → Include by pattern → `release/**`;
- tick **Restrict creations**. Without it, anyone with Contents write can
  create `release/x` at their own commit, and a tag on that commit passes the
  ancestry check in `Release: Verify`;
- tick **Restrict deletions** and **Block force pushes**;
- tick **Require a pull request before merging**, with the same settings as
  `main`;
- tick **Require status checks to pass**, and add the CI checks `main` requires.
  Don't add the `Release: …` checks: they run only when the release inputs
  change, so on any other PR a required one would wait forever;
- **Create**.

`release/0.5.0` already exists; Restrict creations only affects new branches.

```bash
gh api repos/auzroz/ynab-mcp/rulesets --jq '.[] | [.id, .name, .target] | @tsv'
gh api repos/auzroz/ynab-mcp/rulesets/<id> --jq '{include: .conditions.ref_name.include, rules: [.rules[].type]}'
# expect include ["refs/heads/release/**"] and rules containing
# creation, deletion, non_fast_forward, pull_request, required_status_checks
```

### 2. Thu Nov 12: Restrict creations on the tag ruleset

Settings → Rules → Rulesets → **Protect release tags**:

- tick **Restrict creations** (it already has Restrict updates, Restrict
  deletions and Block force pushes);
- check that **Bypass list** has Repository admin with **Always allow**, or your
  own `git push origin vX.Y.Z` is refused too;
- **Save changes**.

```bash
gh api repos/auzroz/ynab-mcp/rulesets/<id> --jq '{include: .conditions.ref_name.include, bypass: .bypass_actors, rules: [.rules[].type]}'
# expect rules containing creation, update, deletion, non_fast_forward
```

### 3. Thu Nov 12: the `production` environment

Settings → Environments → New environment → name `production` → Configure
environment:

- tick **Required reviewers** and add `auzroz`. Leave **Prevent self-review**
  unticked: you push the tag and approve it;
- leave **Wait timer** off;
- untick **Allow administrators to bypass configured protection rules**, so
  every publish waits for an explicit approval, yours included;
- **Deployment branches and tags** → Selected branches and tags → Add
  deployment branch or tag rule → **Ref type: Tag**, name pattern `v*.*.*` →
  Add rule. Add no branch rule;
- **Save protection rules**. Add no variables. The environment's one secret,
  `GHCR_PUSH_TOKEN`, comes in step 5.

```bash
gh api repos/auzroz/ynab-mcp/environments/production \
  --jq '{rules: [.protection_rules[].type], policy: .deployment_branch_policy, admins_bypass: .can_admins_bypass}'
# expect rules [required_reviewers, branch_policy], custom_branch_policies true, admins_bypass false
gh api repos/auzroz/ynab-mcp/environments/production/deployment-branch-policies \
  --jq '.branch_policies[] | [.name, .type] | @tsv'
# expect exactly one line: v*.*.*  tag
```

### 4. Thu Nov 12, same sitting: the npm trusted publisher names `production`

npmjs.com → `ynab-mcp` → Settings → Trusted Publisher (GitHub Actions) → edit:

- Organization or user `auzroz`, Repository `ynab-mcp`, Workflow filename
  `release.yml`, **Environment name `production`** → Update;
- recommended: under **Publishing access**, choose **Require two-factor
  authentication and disallow tokens** → Update Package Settings, and revoke
  any access token that can publish `ynab-mcp`. Trusted publishing and your own
  2FA publish keep working.

Why the environment name matters: with the field empty, npm accepts an OIDC
token from any job that runs a `release.yml` in this repository, including a
branch run whose `release.yml` was edited to add `id-token: write`. With it
set, npm accepts only a job in the `production` environment, which step 3
limits to `v*.*.*` tags and your approval.

**From this moment, npm accepts only a `release.yml` that runs its publish
job in `production`.** `main` and `release/0.5.0` both have one (#84 brought
it to `main`), so a 0.4.x patch tagged on `main` releases as in
CONTRIBUTING.md. Any other branch whose `release.yml` predates #76 can't
publish. Don't clear the Environment field to make an old workflow work.

To check, open the package's Settings page and confirm the trusted publisher
shows `release.yml` and `production`.

Steps 5 to 7 and step 10 are 62b of #62 (decisions D-1 and D-2). Steps 5 to 7
come, in this order, once the 62b pull request has merged into `release/0.5.0`
and before the `v0.5.0-rc.1` tag. Until step 5 is done, `Release: Publish
image` fails; until step 7 is merged, `Release: Verify` refuses every tag.
Step 10, the package's switch to Read, waits for the 0.5.0 release.

### 5. Before rc.1: the ghcr push token (`GHCR_PUSH_TOKEN`)

Done already for 0.5.0; these steps are also the renewal.

`Release: Publish image` has no `packages: write`. It logs in to ghcr with this
token, and fails with "The production environment has no GHCR_PUSH_TOKEN
secret" if it is missing.

1. GitHub → your avatar → Settings → Developer settings → Personal access
   tokens → **Tokens (classic)** → Generate new token → Generate new token
   (classic):
   - **Note** `ynab-mcp release image push`;
   - **Expiration** 90 days;
   - **Select scopes:** tick only `write:packages` (GitHub ticks
     `read:packages` with it). Nothing else: no `repo`, no `delete:packages`,
     no `workflow`;
   - **Generate token**, and copy it. It isn't shown again.
2. Store it as an environment secret, not a repository secret: Settings →
   Environments → `production` → Environment secrets → **Add environment
   secret**, name `GHCR_PUSH_TOKEN`, paste the token → Add secret. Or from
   your terminal, which prompts for the value without echoing it:

   ```bash
   gh secret set GHCR_PUSH_TOKEN --env production -R auzroz/ynab-mcp
   ```

```bash
gh api repos/auzroz/ynab-mcp/environments/production/secrets --jq '.secrets[] | [.name, .updated_at] | @tsv'
# expect exactly one line: GHCR_PUSH_TOKEN  <when you set it>
gh secret list -R auzroz/ynab-mcp
# expect no GHCR_PUSH_TOKEN: a repository secret would be readable by every job
```

Renew it for each release (the token page → **Regenerate token**, 90 days),
then set the secret again. An expired token shows up as a `denied` or
`unauthorized` ghcr login in `Release: Publish image`.

### 6. Before rc.1: an SSH signing key for tags

Every `v*` tag, release candidates included, is an annotated tag signed with
an SSH key. Use a dedicated key for release tags, with a passphrase (a
hardware key, `-t ed25519-sk`, also works). Configure it in your clone of
`auzroz/ynab-mcp` only, not globally, so other repositories keep their own
signing setup:

```bash
REPO=<path to your auzroz/ynab-mcp clone>
ssh-keygen -t ed25519 -C "ynab-mcp release tag signing" -f "$HOME/.ssh/id_ed25519_release_signing"   # set a passphrase when asked
git -C "$REPO" config gpg.format ssh
git -C "$REPO" config user.signingkey "$HOME/.ssh/id_ed25519_release_signing.pub"
```

Optional: add the public key to GitHub as a **Signing key** (Settings → SSH and
GPG keys → New SSH key → Key type: Signing key), so GitHub shows the tags as
Verified. The release gate doesn't use that; it reads only
`.github/allowed_signers`.

### 7. Before rc.1: the key in `.github/allowed_signers`

A pull request into `release/0.5.0` adds one line, and removes the header's
last line ("No key is listed yet…"). The first field, the principal, is a
label, such as your GitHub login. It doesn't have to match the email on your
tags, and the file is public, so it must not be an email address:

```bash
printf 'auzroz namespaces="git" %s\n' "$(cut -d' ' -f1-2 "$HOME/.ssh/id_ed25519_release_signing.pub")" >> .github/allowed_signers
bash scripts/verify-tag-signature.sh   # expect ".github/allowed_signers parses: 1 key(s)."
```

The pull request runs `Release: Verify`, which checks that the file parses.
After it merges, check a local signed tag against the file, from your clone
(configured in step 6) at the merge commit on `release/0.5.0`. Never push this
tag:

```bash
git tag -s v0.0.0-signing-check -m v0.0.0-signing-check HEAD
bash scripts/verify-tag-signature.sh v0.0.0-signing-check
# expect "v0.0.0-signing-check is an annotated tag signed by a key listed in .github/allowed_signers."
git tag -d v0.0.0-signing-check
```

### 8. Optional: the scratch repository

Only if you also want a scratch rehearsal (see the note at the top). Do "Before
you start" below. It is the only place where the `GITHUB_TOKEN` push refusal
(section 3b) is exercised, and where the signature refusals of check 1 run as
real tag pushes (the self-test in `Release: Verify` covers them on every pull
request and dry run). A release candidate proves only the path that passes.

### 9. Thu Dec 10: the release candidate

Follow CONTRIBUTING.md "Release candidates" for `v0.5.0-rc.1` (#86), with a
signed tag. The package is still Write at this point, which is fine: the
candidate's `release.yml` has no `packages: write` and pushes with
`GHCR_PUSH_TOKEN`. A scratch rehearsal (sections 1 to 6 below, with 2b and 3b)
can come first, but it doesn't replace the candidate: it runs npm in dry-run
mode outside this repository, so it never exercises the real publish.

### 10. When 0.5.0 merges to `main`, before the 0.5.0 tag: ghcr package access set to Read

Not earlier: until 0.5.0 is on `main`, `main`'s `release.yml` pushes the image
with `GITHUB_TOKEN` and `packages: write`, and a 0.4.x patch release from
`main` needs that. Once the REL PR has merged `release/0.5.0` into `main`,
every branch that can release has 62b, so the switch closes the gap without
breaking a release.

`https://github.com/users/auzroz/packages/container/ynab-mcp/settings`:

- if **Inherit access from source repository** is ticked, untick it, so the
  role below is the one that applies;
- **Manage Actions access**: only `auzroz/ynab-mcp` is listed, with role
  **Read** (change it from Write: the role drop-down next to the repository).
  Remove any other repository.

With Read, the workflow's own `GITHUB_TOKEN` can pull but not push, even in a
job that asks for `packages: write`. `GHCR_PUSH_TOKEN` still pushes, as the
package's owner. There is no API for this setting: check the page shows
`auzroz/ynab-mcp` with role Read and nothing else.

**A 0.4.x patch needed before 0.5.0 merges to `main`** ships before this
switch, from `main` as today, or after 62b has been backported to `main`
first. While `main`'s `release.yml` still has `packages: write`, switching
the package to Read breaks its image push.

### 11. Fri Dec 18: the release

Follow CONTRIBUTING.md "How a release runs": merge the REL PR into `main`, do
step 10, dispatch the dry run on `main` (G16d), make and push the signed tag,
approve the two prompts (image, then npm), and run the step 6 checks of "How a
release runs" (G16e). Then move npm's `next` tag off the candidate: `npm
dist-tag add ynab-mcp@0.5.0 next`. The final tag is also the first run of the
npm wait in `Release: MCP Registry` (#121), which candidates skip.

## Before you start (one time)

These are the scratch-repo steps of admin checklist step 8.

1. Create a **public** repository `auzroz/ynab-mcp-release-rehearsal` with no
   README, license or `.gitignore`. It has to be public, because artifact
   attestations need a public repository on a personal account. Keep the name
   lowercase, because it becomes the ghcr image name.
2. In the scratch repo, go to Settings → Environments → New environment and
   name it `production`. Then:
   - tick **Required reviewers** and add `auzroz`;
   - leave **Prevent self-review** unticked (you push the tag and approve it);
   - under **Deployment branches and tags**, choose **Selected branches and
     tags**, then add a rule with **Ref type: Tag** and name pattern `v*.*.*`;
   - save the protection rules;
   - add the environment secret `GHCR_PUSH_TOKEN`, as in admin checklist step
     5 (the same token works: the scratch image is your package too):
     `gh secret set GHCR_PUSH_TOKEN --env production -R auzroz/ynab-mcp-release-rehearsal`.
3. Check that your `gh` login can push workflow files and delete packages:

   ```bash
   export PATH=/opt/homebrew/bin:$PATH
   gh auth status            # scopes must include repo and workflow
   gh auth refresh -s workflow,read:packages,delete:packages   # only if they're missing
   gh auth setup-git
   ```
4. Have your release signing key from admin checklist step 6. Section 1
   configures it in the rehearsal clone only, as `SIGNING_PUB`.

## 1. Prepare a rehearsal copy

`REF` is the branch under test. Before a change to the release path merges,
use its PR branch. After it merges, use `release/0.5.0` for a 0.5.0
rehearsal, or `main` for a 0.4.x one.

```bash
export PATH=/opt/homebrew/bin:$PATH
SCRATCH=auzroz/ynab-mcp-release-rehearsal
REF=release/0.5.0   # the branch under test (see above)
V=0.0.0-rehearsal.1
WORK="$(mktemp -d)"
SIGNING_PUB="$HOME/.ssh/id_ed25519_release_signing.pub"   # admin checklist step 6
test -f "$SIGNING_PUB" && echo "signing with $SIGNING_PUB"

git clone --no-tags --single-branch --branch "$REF" https://github.com/auzroz/ynab-mcp.git "$WORK/r"
cd "$WORK/r"
git switch -c rehearsal-main
# Signing for this clone only.
git config gpg.format ssh
git config user.signingkey "$SIGNING_PUB"
```

`--no-tags` matters: none of the real `v*` tags may reach the scratch repo,
because each one would start a release run there.

Make one rehearsal commit. It points the publish-job guards at the scratch
repo, removes the other workflows and Dependabot, and sets the rehearsal
version everywhere `Release: Verify` checks it.

```bash
# Publish-job guards: four `if:` lines, all rewritten.
sed -i '' "s#github.repository == 'auzroz/ynab-mcp'#github.repository == '$SCRATCH'#g" .github/workflows/release.yml
grep -c "github.repository == '$SCRATCH'" .github/workflows/release.yml      # expect 4
grep -c "github.repository == 'auzroz/ynab-mcp'" .github/workflows/release.yml  # expect 0

# The npm step's own repository check is NOT rewritten, so npm stays a dry run.
grep -n 'GITHUB_REPOSITORY" = "auzroz/ynab-mcp"' .github/workflows/release.yml  # expect 1 line

# Only release.yml runs in the scratch repo.
find .github/workflows -type f ! -name release.yml -exec git rm -q {} +
git rm -q --ignore-unmatch .github/dependabot.yml

# Rehearsal version in package.json, package-lock.json and server.json.
npm version "$V" --no-git-tag-version --ignore-scripts
node -e 'const fs=require("fs");const v=process.argv[1];const s=JSON.parse(fs.readFileSync("server.json","utf8"));s.version=v;for(const p of s.packages){if(p.registryType==="oci")p.identifier=p.identifier.replace(/:[^:]+$/,":"+v);else p.version=v;}fs.writeFileSync("server.json",JSON.stringify(s,null,2)+"\n")' "$V"

# Your signing key in .github/allowed_signers, unless REF already lists it.
KEY="$(cut -d' ' -f1-2 "$SIGNING_PUB")"
grep -qF "$KEY" .github/allowed_signers || printf 'rehearsal namespaces="git" %s\n' "$KEY" >> .github/allowed_signers
bash scripts/verify-tag-signature.sh   # expect ".github/allowed_signers parses: N key(s)." with N >= 1

# A throwaway key that is NOT in the file, for the unlisted-key check.
ssh-keygen -q -t ed25519 -N '' -C 'rehearsal: unlisted' -f "$WORK/unlisted"
git diff --stat

git add -A
git commit -m "rehearsal: $V in $SCRATCH"
```

Make a second commit on a branch that is not `main` or `release/*`. It is the
commit check 2 tags and expects to see refused.

```bash
git switch -c feature/not-a-release
git commit --allow-empty -m "rehearsal: a commit that is not on main"
git switch rehearsal-main
```

Push `main` first, make it the default branch (step 5 dispatches on it), then
push the other branch. A later rehearsal starts from a fresh clone, so its
commits don't descend from the previous rehearsal's, and a plain push would be
rejected. Each push therefore replaces the scratch branch, but only if it is
still at the SHA read just before (empty on the first rehearsal, which means
the branch must not exist yet):

```bash
git remote add scratch "https://github.com/$SCRATCH.git"
OLD_MAIN="$(git ls-remote scratch refs/heads/main | cut -f1)"
OLD_OFF="$(git ls-remote scratch refs/heads/feature/not-a-release | cut -f1)"
git push --force-with-lease="refs/heads/main:$OLD_MAIN" scratch rehearsal-main:refs/heads/main
gh repo edit "$SCRATCH" --default-branch main
gh repo view "$SCRATCH" --json defaultBranchRef --jq .defaultBranchRef.name   # expect main
git push --force-with-lease="refs/heads/feature/not-a-release:$OLD_OFF" scratch feature/not-a-release:refs/heads/feature/not-a-release

MAIN_SHA="$(git rev-parse rehearsal-main)"
OFF_SHA="$(git rev-parse feature/not-a-release)"
```

Branch pushes don't start `release.yml`, because it has no branch-push trigger.

A helper for the steps below. `wait_run EVENT SHA [AFTER]` waits up to five
minutes for a release run started by `EVENT` on commit `SHA` whose id is greater
than `AFTER` (default 0), then prints its id. Matching the commit means it can't
pick up an earlier run by mistake.

```bash
wait_run() {
  local id="" i
  for i in $(seq 60); do
    id="$(gh run list -R "$SCRATCH" --workflow release.yml --event "$1" --commit "$2" --limit 20 \
      --json databaseId --jq "[.[] | select(.databaseId > ${3:-0}) | .databaseId] | max // empty")"
    if [ -n "$id" ]; then echo "$id"; return 0; fi
    sleep 5
  done
  echo "no $1 run on $2 after 5 minutes" >&2
  return 1
}
```

## 2. A tag off `main` is refused

```bash
# Signed, so the ancestry check is what refuses it.
git tag -s "v$V" -m "rehearsal: must be refused" feature/not-a-release
git push scratch "refs/tags/v$V"
RUN="$(wait_run push "$OFF_SHA")"; echo "run $RUN"
gh run watch "$RUN" -R "$SCRATCH"            # ends in failure; that is the pass condition
gh run view "$RUN" -R "$SCRATCH" --json jobs --jq '.jobs[] | [.name, .conclusion] | @tsv'
gh run view "$RUN" -R "$SCRATCH" --log-failed | grep "Refusing to release"
gh api "repos/$SCRATCH/actions/runs/$RUN/pending_deployments" --jq 'length'   # expect 0
```

**Pass:** `Release: Verify` failed with "is not on main or any release/*
branch. Refusing to release.", and every other job is `skipped`. No approval
was requested.

Remove the tag so the same version can be tagged on `main`:

```bash
git push scratch ":refs/tags/v$V"
git tag -d "v$V"
```

## 2b. Tags on `main` that aren't signed by an allowed key are refused

Three tags on the `main` commit, one after another: a lightweight tag, an
unsigned annotated tag, and a tag signed with the throwaway key that isn't in
`.github/allowed_signers`. Each run must fail in `Release: Verify` with its own
error.

```bash
LAST=0
for kind in lightweight unsigned unlisted; do
  case "$kind" in
    # --no-sign: with tag.gpgSign=true, git would sign these two anyway.
    lightweight) git tag --no-sign "v$V" rehearsal-main ;;
    unsigned)    git tag --no-sign -a "v$V" -m "rehearsal: unsigned" rehearsal-main ;;
    unlisted)    git -c user.signingkey="$WORK/unlisted.pub" tag -s "v$V" -m "rehearsal: unlisted key" rehearsal-main ;;
  esac
  git push scratch "refs/tags/v$V"
  RUN="$(wait_run push "$MAIN_SHA" "$LAST")"; echo "$kind: run $RUN"
  gh run watch "$RUN" -R "$SCRATCH" > /dev/null || true   # ends in failure; that is the pass condition
  gh run view "$RUN" -R "$SCRATCH" --json jobs --jq '.jobs[] | select(.conclusion != "skipped") | [.name, .conclusion] | @tsv'
  gh run view "$RUN" -R "$SCRATCH" --log-failed | grep -E "is not an annotated tag|has no SSH signature|is not signed by a key listed"
  gh api "repos/$SCRATCH/actions/runs/$RUN/pending_deployments" --jq 'length'   # expect 0
  LAST="$RUN"
  git push scratch ":refs/tags/v$V"
  git tag -d "v$V"
done
```

**Pass:** for each kind, only `Release: Verify` ran, and it failed in "Verify
the tag is signed by an allowed key" with, in order: "is not an annotated
tag", "has no SSH signature", "is not signed by a key listed in
.github/allowed_signers". No approval was requested.

## 3. A signed tag on `main` asks for two approvals

```bash
git tag -s "v$V" -m "rehearsal" rehearsal-main
git -c gpg.ssh.allowedSignersFile=.github/allowed_signers verify-tag "v$V"   # the same check Verify makes
git push scratch "refs/tags/v$V"
RUN="$(wait_run push "$MAIN_SHA" "$LAST")"; echo "run $RUN"
TAG_RUN="$RUN"
echo "https://github.com/$SCRATCH/actions/runs/$RUN"
```

`Release: Verify`, `Test`, `Build and pack` and both `Image` jobs run first
(10 to 20 minutes). Then:

1. **First approval.** The run page shows **Review deployments** for
   `Release: Publish image`. Tick `production`, then **Approve and deploy**.
   From the terminal instead:

   ```bash
   gh api "repos/$SCRATCH/actions/runs/$RUN/pending_deployments" --jq '.[] | [.environment.id, .environment.name] | @tsv'
   ENV_ID="$(gh api "repos/$SCRATCH/actions/runs/$RUN/pending_deployments" --jq '.[0].environment.id')"
   gh api -X POST "repos/$SCRATCH/actions/runs/$RUN/pending_deployments" -F "environment_ids[]=$ENV_ID" -f state=approved -f comment="rehearsal: image"
   ```

2. **Second approval.** After the image job finishes, the run asks again, this
   time for `Release: Publish npm`. Approve it the same way (comment
   "rehearsal: npm").

```bash
gh run watch "$RUN" -R "$SCRATCH" --exit-status
gh run view "$RUN" -R "$SCRATCH" --json jobs --jq '.jobs[] | [.name, .conclusion] | @tsv'
NPM_JOB="$(gh run view "$RUN" -R "$SCRATCH" --json jobs --jq '.jobs[] | select(.name == "Release: Publish npm") | .databaseId')"
gh run view "$RUN" -R "$SCRATCH" --job "$NPM_JOB" --log | grep -E "dry run|dry-run|ynab-mcp@$V"
VERIFY_JOB="$(gh run view "$RUN" -R "$SCRATCH" --json jobs --jq '.jobs[] | select(.name == "Release: Verify") | .databaseId')"
gh run view "$RUN" -R "$SCRATCH" --job "$VERIFY_JOB" --log | grep -E 'Good "git" signature for|signed by a key listed'
gh run view "$RUN" -R "$SCRATCH" --json jobs --jq '.jobs[] | select(.name == "Release: Publish image") | .steps[] | [.name, .conclusion] | @tsv'
```

**Pass:** two separate approvals were requested, image first. Every job
succeeded except `Release: MCP Registry`, which is `skipped` (no
`PUBLISH_MCP_REGISTRY` variable in the scratch repo, and a prerelease
version). The Verify log shows `Good "git" signature for` your principal. In
`Release: Publish image`, "Check the ghcr push token is set" and the ghcr
login succeeded (the login uses `GHCR_PUSH_TOKEN`). The npm log shows the
dry-run notice and `ynab-mcp@0.0.0-rehearsal.1` with `(dry-run)`.

## 3b. The workflow's `GITHUB_TOKEN` can't push the image

The push in section 3 created the scratch package. Set its Actions access as
in admin checklist step 10 (the scratch repo has no 0.4.x line to wait for):
`https://github.com/users/auzroz/packages/container/ynab-mcp-release-rehearsal/settings`
→ untick **Inherit access from source repository** if it is ticked →
**Manage Actions access**: `auzroz/ynab-mcp-release-rehearsal` with role
**Read**.

Then a branch workflow that asks for `packages: write` tries to add a tag to
the image with `GITHUB_TOKEN`:

```bash
git switch -c probe/token-push rehearsal-main
cat > .github/workflows/token-probe.yml <<EOF
name: token-probe
on:
  push:
    branches: [probe/token-push]
permissions:
  contents: read
  packages: write
jobs:
  push:
    runs-on: ubuntu-latest
    steps:
      - env:
          TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          printf '%s' "\$TOKEN" | docker login ghcr.io -u "\$GITHUB_ACTOR" --password-stdin
          docker buildx imagetools create --tag "ghcr.io/$SCRATCH:token-probe" "ghcr.io/$SCRATCH:$V"
EOF
git add .github/workflows/token-probe.yml
git commit -m "rehearsal: GITHUB_TOKEN push probe"
PROBE_SHA="$(git rev-parse HEAD)"
git push scratch probe/token-push:refs/heads/probe/token-push
PROBE="$(gh run list -R "$SCRATCH" --event push --commit "$PROBE_SHA" --limit 1 --json databaseId --jq '.[0].databaseId // empty')"
# empty right after the push: run the line above again after a few seconds
gh run watch "$PROBE" -R "$SCRATCH" > /dev/null || true   # ends in failure; that is the pass condition
gh run view "$PROBE" -R "$SCRATCH" --log-failed | grep -iE "denied|forbidden|unauthorized"
git switch rehearsal-main
git push scratch :refs/heads/probe/token-push
```

**Pass:** the probe failed at the push (or at the login) with `denied`,
`403 Forbidden` or `unauthorized`, and no `token-probe` tag exists on the
scratch package. If it pushed, the package's role is still Write or inherits
from the repository: fix the setting, delete the `token-probe` version, and
rerun this section.

Confirm npm saw nothing:

```bash
npm view "ynab-mcp@$V" version   # expect no output (or E404): the version doesn't exist
```

## 4. Attestations and checksums verify

If `gh attestation verify oci://…` below can't read the image, make the
package public: `https://github.com/users/auzroz/packages/container/ynab-mcp-release-rehearsal/settings`,
then Danger Zone → Change visibility → Public.

```bash
mkdir "$WORK/dl" && cd "$WORK/dl"
gh release download "v$V" -R "$SCRATCH"
ls
shasum -a 256 -c SHA256SUMS

WF="$SCRATCH/.github/workflows/release.yml"
SRC="refs/tags/v$V"

# Build provenance: tarball, every skills zip, SBOM
gh attestation verify "ynab-mcp-$V.tgz" -R "$SCRATCH" --signer-workflow "$WF" --source-ref "$SRC" --deny-self-hosted-runners
for f in *.zip "ynab-mcp-$V.spdx.json"; do
  gh attestation verify "$f" -R "$SCRATCH" --signer-workflow "$WF" --source-ref "$SRC" --deny-self-hosted-runners || echo "FAILED: $f"
done

# SBOM attestation on the tarball
gh attestation verify "ynab-mcp-$V.tgz" -R "$SCRATCH" --signer-workflow "$WF" --predicate-type https://spdx.dev/Document/v2.3

# Image: provenance and SBOM, from the GitHub API and from the registry
IMG="oci://ghcr.io/$SCRATCH:$V"
gh attestation verify "$IMG" -R "$SCRATCH" --signer-workflow "$WF" --source-ref "$SRC" --deny-self-hosted-runners
gh attestation verify "$IMG" -R "$SCRATCH" --signer-workflow "$WF" --predicate-type https://spdx.dev/Document/v2.3
gh attestation verify "$IMG" -R "$SCRATCH" --signer-workflow "$WF" --bundle-from-oci

# Negative check: the same tarball must NOT verify as an auzroz/ynab-mcp artifact.
# Only "no attestation for this digest in that repo" counts as a refusal. gh 2.103
# reports it as an HTTP 404 from that repo's attestations API; older releases say
# "no attestations found". An auth, network or CLI error is not a refusal.
if out=$(gh attestation verify "ynab-mcp-$V.tgz" -R auzroz/ynab-mcp 2>&1); then
  echo "UNEXPECTED: verified"
elif grep -Eq 'HTTP 404: Not Found \(https://api\.github\.com/repos/auzroz/ynab-mcp/attestations/sha256:|no attestations found' <<<"$out"; then
  echo "refused, as expected"
else
  printf 'NEGATIVE CHECK ERROR (not a refusal):\n%s\n' "$out"
fi
```

**Pass:** `shasum` prints `OK` for every file, each `gh attestation verify`
above the negative check exits 0 with no `FAILED:` line, and the negative check
prints "refused, as expected". "UNEXPECTED: verified" or "NEGATIVE CHECK ERROR"
fails this step; for the second, fix the cause and run the check again.

## 5. The dispatch dry run (rehearses G16d)

```bash
gh workflow run release.yml -R "$SCRATCH" --ref main -f dry_run=true
RUN="$(wait_run workflow_dispatch "$MAIN_SHA" "$TAG_RUN")"; echo "run $RUN"
gh run watch "$RUN" -R "$SCRATCH" --exit-status
gh run view "$RUN" -R "$SCRATCH" --json jobs --jq '.jobs[] | [.name, .conclusion] | @tsv'
DRY_RUN="$RUN"

gh workflow run release.yml -R "$SCRATCH" --ref main -f dry_run=false
RUN="$(wait_run workflow_dispatch "$MAIN_SHA" "$DRY_RUN")"; echo "run $RUN"
gh run watch "$RUN" -R "$SCRATCH"            # ends in failure; that is the pass condition
gh run view "$RUN" -R "$SCRATCH" --log-failed | grep "only runs dry"
```

**Pass:** the `dry_run=true` run is green. Its publish jobs are `skipped` and
it asked for no approval. The `dry_run=false` run fails in `Release: Verify`
with "workflow_dispatch only runs dry".

## 6. Clean up

```bash
gh release delete "v$V" -R "$SCRATCH" --yes --cleanup-tag
gh api -X DELETE /user/packages/container/ynab-mcp-release-rehearsal   # needs delete:packages
# The token can push to all of your packages: don't leave a copy in the scratch repo.
gh secret delete GHCR_PUSH_TOKEN --env production -R "$SCRATCH"
cd / && rm -rf "$WORK"
```

Keep the scratch repository and its `production` environment for the next
rehearsal (set the secret again first; deleting the package also drops the
Actions access setting that section 3b makes). To rehearse again, use the next number (`0.0.0-rehearsal.2`) or
delete the old tag first.

## Report

Send the lead one line per check: pass or fail, plus the run URL. Add the
first error line for any failure.

| Check | Expected |
|---|---|
| 2. Tag off `main` | Verify refuses; nothing else runs; no approval requested |
| 2b. Unsigned tags | Lightweight, unsigned and unlisted-key tags each refused by Verify with their own error; no approval requested |
| 3. Signed tag on `main` | Verify shows a good signature; two approvals (image, then npm); all jobs green; image pushed with `GHCR_PUSH_TOKEN`; npm `--dry-run`; nothing on npmjs.com |
| 3b. `GITHUB_TOKEN` push | With the package's role Read, a `packages: write` branch workflow can't push |
| 4. Attestations | `SHA256SUMS` OK; provenance verifies for every file in `SHA256SUMS` and the image; SBOM attestations verify for the tarball and image only; negative check refused |
| 5. Dispatch | `dry_run=true` green with no approval; `dry_run=false` refused |
