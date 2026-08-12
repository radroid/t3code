# Giving the fork's releases a canonical "Latest"

Every fork release is published as a GitHub **pre-release**. GitHub refuses to mark a pre-release as
latest, so the repository has no latest release at all:

| Surface                                               | Today                             |
| ----------------------------------------------------- | --------------------------------- |
| `api.github.com/repos/radroid/t3code/releases/latest` | `404`                             |
| `github.com/radroid/t3code/releases/latest`           | falls back to the releases _list_ |
| Repository sidebar                                    | no "Latest" badge                 |
| `gh release download` with no tag                     | fails                             |

The download chain itself already works and is not what this changes. `coil-release.yml` publishes a
`.dmg`, an `.exe` and `coil-latest.json` on every green merge; the relay serves that manifest; and
`coil.curlycloud.dev/download` reads the relay and wires real asset URLs. What is missing is a
canonical download for anyone who arrives at GitHub instead of the website, and for any tooling that
resolves a release by asking GitHub which one is current.

`apps/coil-home/src/lib/releases.ts` documents the 404 as the reason the site reads the relay rather
than GitHub's API. That reason expires here. The site keeps reading the relay anyway, for the better
reason: one source of truth means the app and the site agree on "latest" by construction rather than
by coincidence.

## Decisions

| Question                     | Decision                                                    |
| ---------------------------- | ----------------------------------------------------------- |
| How a release becomes latest | Every build is a full release; the newest is marked latest  |
| Which build wins the pointer | Only the build whose commit is `main`'s tip at resolve time |
| Curated "stable" channel     | No                                                          |
| Retention                    | 10 releases total, across both tag prefixes                 |
| Website behaviour            | Unchanged — still reads the relay                           |

### Why not a curated stable channel

The obvious alternative is to keep per-commit builds as pre-releases and add a `workflow_dispatch`
that promotes a chosen one to latest. It preserves the conventional meaning of "pre-release", and it
was rejected.

Nothing in this repository defines stable beyond green CI, and CI already gates every build. A
promoted release would therefore be an arbitrary snapshot, and it would go stale the moment attention
moved elsewhere — at which point GitHub's "Latest" and the website's "latest" would name different
builds. That is worse than the current state, where GitHub simply declines to answer. A wrong answer
outranks no answer in how much damage it does.

The honest description of this fork is that there is exactly one channel. The download page hands
these builds to first-time users as _the_ download; labelling them pre-releases on GitHub is the
inconsistency, not the fix. The "this is not a polished product" signal stays where it already is and
where a reader actually meets it: the release notes lead with "Automated fork build" and the unsigned
binary warnings.

A rolling `latest` tag whose assets are replaced each build was also rejected. Mutating assets under
a fixed tag destroys the per-build identity that the manifest, the updater and the copy-paste install
commands all depend on — the workflow's own comment puts it as _version answers "which is newer", the
hash answers "which commit"_.

## The tip gate

`make_latest` is not set unconditionally. The `resolve` job compares the commit being built against
`git ls-remote origin refs/heads/main` and publishes an `is_tip` output; the release is marked latest
only when they match.

Two things make this load-bearing rather than defensive:

**The workflow documents a republish recipe.** When publishing fails after five attempts it prints
`gh workflow run coil-release.yml -f sha=$TARGET_SHA`. That path is also reachable with any older
sha, and an unconditional `make_latest: true` would let a deliberate rebuild of an old commit demote
the current build to second place.

**Runs can publish out of order.** The `coil-release` concurrency group is `cancel-in-progress:
false`, and GitHub keeps only one pending run per group. Two merges landing close together are
ordinary here, and the order in which their releases are published is not guaranteed to match the
order the commits landed. The tip gate is self-correcting under that race: whichever run _is_ the tip
takes the pointer, and a late-running older build declines it instead of clobbering it.

`make_latest: false` leaves the existing pointer alone rather than clearing it, so there is no window
in which the repository has no latest release.

## The prune fix

This is required by the change, not bundled with it. The retention step selects on `isPrerelease`,
which is about to be uniformly false — leaving it alone would not degrade retention, it would
disable it.

The step is already broken, independently. Its filter is:

```
select(.isPrerelease and (.tagName | startswith("t3x-build-")))
```

`#71` renamed release tags from `t3x-build-*` to `coil-build-*`. The changelog lookup was updated to
match **both** prefixes permanently and says why (line 176); this filter was missed. So it has been
capping the old prefix at 10 while the new prefix grows without limit, at roughly 300 MB a build.
Confirmed against the live repository: exactly 10 `t3x-build-*`, and 4 `coil-build-*` and counting.

The replacement:

```
[.[] | select((.tagName|startswith("coil-build-")) or (.tagName|startswith("t3x-build-")))]
| sort_by(.createdAt) | reverse | .[10:] | .[] | select(.isLatest | not) | .tagName
```

Three changes. Both prefixes, permanently, for the same reason the changelog lookup keeps both: old
tags do not expire, so a filter that knows only the current prefix silently re-breaks the day the
prefix changes again. `isPrerelease` dropped from the predicate. And an `isLatest` exclusion, so that
retention can never delete the pointer this whole change exists to create — the cap already keeps the
newest 10 and the latest release is the newest, so this is a backstop against a future edit to the
ordering rather than a live risk.

The cap becomes 10 across both prefixes combined, where it was 10 of one prefix plus unbounded growth
of the other. The first run after this lands deletes the 4 oldest `t3x-build-*` releases, taking the
repository from 14 to 10. That is the policy that was already written; it has just never been
enforced on the new prefix.

## Scope

Changed:

- `.github/workflows/coil-release.yml` — the `is_tip` output, `prerelease: false` plus
  `make_latest`, the same flags on the `gh release create` retry path, and the prune filter.
- `apps/coil-home/src/lib/releases.ts` — the comment explaining the 404, which stops being true.

Not changed: the relay, the manifest format, the updater, the download page's behaviour, and
`docs/coil/SEAMS.md` — fork-only files such as this workflow sit at zero rows in the seam table
(`SEAMS.md:171`), so there is nothing to re-baseline.

## Verification

Before merge, the prune filter is checked against live release data, since it is the part that
deletes things. Run against the repository as it stands it selects exactly the 4 oldest
`t3x-build-*` tags and keeps the newest 10.

After the next release run:

- `api.github.com/repos/radroid/t3code/releases/latest` returns `200` naming the new tag
- exactly one release reports `isLatest: true`
- the total release count is 10
- the download page and the relay still serve the same build they did before
