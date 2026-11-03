# Release workflow rehearsal (scratch repository)

This runs the tag path of `.github/workflows/release.yml` end to end in a public
scratch repository, so the first gated release of `auzroz/ynab-mcp` is not also
the first time the workflow runs. It takes about an hour, most of it waiting for
the image builds.

The rehearsal proves four things (plan gate G16b):

1. **Ancestry check.** A tag on a commit that is not on `main` or a `release/*`
   branch is refused by `Release: Verify`, before any job asks for an approval.
2. **Two approvals.** A tag on a commit on `main` stops twice for a
   `production` approval: first `Release: Publish image`, then
   `Release: Publish npm`.
3. **Attestations.** The build provenance and SBOM attestations on the npm
   tarball, the skills zips and the image verify with `gh attestation verify`,
   and `SHA256SUMS` matches the release files.
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
- **Save protection rules**. Add no environment secrets or variables.

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

**From this moment, `main`'s current `release.yml` (no environment) can't
publish to npm.** Don't push a `v0.4.x` tag on `main` until this `release.yml`
is on `main`. If an emergency 0.4.x is needed before Dec 18, first merge this
`release.yml` and `Dockerfile` into `main` with a PR, then release as in
CONTRIBUTING.md. Don't clear the Environment field to make the old workflow
work.

To check, open the package's Settings page and confirm the trusted publisher
shows `release.yml` and `production`.

### 5. Thu Nov 12: ghcr package access

`https://github.com/users/auzroz/packages/container/ynab-mcp/settings` →
**Manage Actions access**: only `auzroz/ynab-mcp` is listed, with role Write.
Remove any other repository.

This can't limit pushes to the `production` environment: any workflow run in
`auzroz/ynab-mcp` that is granted `packages: write` can push the image. That
residual risk is documented in CONTRIBUTING.md ("What the gate does not
cover") and tracked as 62b.

### 6. Thu Nov 12: the scratch repository

Do "Before you start" below.

### 7. Thu Dec 3: the rehearsal

Do sections 1 to 6 below and send the report.

### 8. Fri Dec 18: the release

Follow CONTRIBUTING.md "How a release runs": merge the REL PR into `main`,
dispatch the dry run on `main` (G16d), tag, approve the two prompts (image,
then npm), and run the step 6 checks (G16e).

## Before you start (one time)

These are the scratch-repo steps of admin checklist step 6.

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
   - save the protection rules.
3. Check that your `gh` login can push workflow files and delete packages:

   ```bash
   export PATH=/opt/homebrew/bin:$PATH
   gh auth status            # scopes must include repo and workflow
   gh auth refresh -s workflow,read:packages,delete:packages   # only if they're missing
   gh auth setup-git
   ```

## 1. Prepare a rehearsal copy

`REF` is the branch under test: the 62a PR head before it merges,
`release/0.5.0` after.

```bash
export PATH=/opt/homebrew/bin:$PATH
SCRATCH=auzroz/ynab-mcp-release-rehearsal
REF=feature/ws8.03-release-gate
V=0.0.0-rehearsal.1
WORK="$(mktemp -d)"

git clone --no-tags --single-branch --branch "$REF" https://github.com/auzroz/ynab-mcp.git "$WORK/r"
cd "$WORK/r"
git switch -c rehearsal-main
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
push the other branch:

```bash
git remote add scratch "https://github.com/$SCRATCH.git"
git push scratch rehearsal-main:refs/heads/main
gh repo edit "$SCRATCH" --default-branch main
gh repo view "$SCRATCH" --json defaultBranchRef --jq .defaultBranchRef.name   # expect main
git push scratch feature/not-a-release:refs/heads/feature/not-a-release

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
git tag -a "v$V" -m "rehearsal: must be refused" feature/not-a-release
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

## 3. A tag on `main` asks for two approvals

```bash
git tag -a "v$V" -m "rehearsal" rehearsal-main
git push scratch "refs/tags/v$V"
RUN="$(wait_run push "$MAIN_SHA")"; echo "run $RUN"
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
```

**Pass:** two separate approvals were requested, image first. Every job
succeeded except `Release: MCP Registry`, which is `skipped` (no
`PUBLISH_MCP_REGISTRY` variable in the scratch repo). The npm log shows the
dry-run notice and `ynab-mcp@0.0.0-rehearsal.1` with `(dry-run)`.

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

# Negative check: the same tarball must NOT verify as an auzroz/ynab-mcp artifact
gh attestation verify "ynab-mcp-$V.tgz" -R auzroz/ynab-mcp && echo "UNEXPECTED: verified" || echo "refused, as expected"
```

**Pass:** `shasum` prints `OK` for every file, each `gh attestation verify`
above the negative check exits 0 with no `FAILED:` line, and the negative check
prints "refused, as expected".

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
cd / && rm -rf "$WORK"
```

Keep the scratch repository and its `production` environment for the next
rehearsal. To rehearse again, use the next number (`0.0.0-rehearsal.2`) or
delete the old tag first.

## Report

Send the lead one line per check: pass or fail, plus the run URL. Add the
first error line for any failure.

| Check | Expected |
|---|---|
| 2. Tag off `main` | Verify refuses; nothing else runs; no approval requested |
| 3. Tag on `main` | Two approvals (image, then npm); all jobs green; npm `--dry-run`; nothing on npmjs.com |
| 4. Attestations | `SHA256SUMS` OK; provenance and SBOM verify for the tarball, zips and image; negative check refused |
| 5. Dispatch | `dry_run=true` green with no approval; `dry_run=false` refused |
