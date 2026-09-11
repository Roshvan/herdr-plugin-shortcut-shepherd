# Release checklist — 0.2.0-alpha.3

## Static checks only

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
```

`pnpm check` runs typecheck and lint only. There are no automated tests, fixtures, or runners,
as requested by the owner. Run the static checks with supported Node releases before publishing;
passing them does not certify runtime behavior on macOS, Linux, or Windows.

The manifest's production dependency command is:

```sh
pnpm install --prod --frozen-lockfile --ignore-scripts
```

## Completed manual review

On macOS with Node 22.18 and Herdr 0.8.2-preview, an isolated configuration/session covered native
GitHub installation, the updated local checkout's startup and repeated start, subscription rotation,
the real stats popup, pause/mute controls, binding reload, input-helper start/stop, shutdown immediately
after an action, and restart with saved statistics. On macOS with Node 26 and Herdr 0.9.0, a live
multi-view session covered a split in a tab that differed from the snapshot's global focus projection.
No automated tests or fixtures were introduced. Normal Herdr configuration and user state were kept
separate from the initial release review.

## Operational review before release

- Review the manifest, runtime source, and dependency lockfile as ordinary unsandboxed user code.
- Confirm compatibility with the intended stable Herdr version and the declared 0.8.0 minimum;
  the initial audit inspected a preview schema, not every target runtime.
- Review startup/readiness, two-session isolation, shutdown, server handoff, popup operation,
  configured-keymap refresh, and storage-recovery behavior before calling this a stable release.
- Keep local macOS input estimates opt-in. Remote clients cannot be observed through the server's
  OS helper; Linux/Windows currently retain unknown input rather than pretending it is mouse use.
- Review Windows state-directory ACLs, hard-link publication, and named-pipe compatibility.
- Stop each session's watcher before disabling, unlinking, uninstalling, or replacing its source.
- Preserve state backups when repairing corrupt files. A failed final save deliberately prevents
  a successful stop acknowledgment rather than silently losing pending statistics.

## Repository status

- Source: [roshvan/herdr-plugin-shortcut-shepherd](https://github.com/roshvan/herdr-plugin-shortcut-shepherd).
- Visibility: **public**. Install from GitHub with the command documented in the README.
- Topic: `herdr-plugin`. Public marketplace discovery still needs verification after the release tag is published.
- The root MIT license and the vendored anti-slop MIT attribution/notice are included.
- `.gitignore` excludes local notes, obsolete screenshots, runtime state, environment files,
  credentials, and dependencies. These do not belong in the initial source snapshot.

## Before a stable release

- [ ] Complete the operational review above, or narrow the declared compatibility accordingly.
- [x] Review source/history for private data before publishing the repository.
- [ ] Keep manifest/package versions consistent and retain the dependency lockfile.
- [ ] Tag a reviewed release and verify direct Herdr installation against that revision.
- [ ] Update the README's private-repository instructions only after public installation succeeds.
- [ ] Confirm marketplace discovery after publication. Discovery refreshes about every 30 minutes;
      listing is not security vetting.
- [ ] Document session-local state, opt-in monitoring, remote limitations, configured-not-effective
      keymaps, and subscription recovery gaps.
