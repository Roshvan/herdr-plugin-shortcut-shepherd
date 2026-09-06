# Release checklist — 0.2.0-alpha.1

## Static checks only

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
```

`pnpm check` runs typecheck and lint only. There are no automated tests, fixtures, or runners,
as requested by the owner. `.github/workflows/check.yml` applies those static checks on
macOS/Linux/Windows and Node 22.18.0/24/26. Passing them does not certify runtime behavior.

The manifest's production dependency command is:

```sh
pnpm install --prod --frozen-lockfile --ignore-scripts
```

## Operational review before release

- Review the manifest, runtime source, and dependency lockfile as ordinary unsandboxed user code.
- Confirm compatibility with the intended stable Herdr version and the declared 0.8.0 minimum;
  the initial audit inspected a preview schema, not every target runtime.
- Review startup/readiness, two-session isolation, shutdown, server handoff, popup operation,
  configured-keymap refresh, and storage-recovery behavior before calling this a stable release.
- Keep local macOS input estimates opt-in. Remote clients cannot be observed through the server's
  OS helper; Linux/Windows currently retain unknown input rather than pretending it is mouse use.
- Review Windows state-directory ACLs, hard-link publication, and named-pipe compatibility.
- Verify an old 0.1.0 watcher is stopped before archiving its legacy PID lock. The new code will
  never signal a process based on that file or silently migrate ambiguous legacy counts.
- Stop each session's watcher before disabling, unlinking, uninstalling, or replacing its source.
- Preserve state backups when repairing corrupt files. A failed final save deliberately prevents
  a successful stop acknowledgment rather than silently losing pending statistics.

## Repository status

- Source: [roshvan/herdr-plugin-shortcut-shepherd](https://github.com/roshvan/herdr-plugin-shortcut-shepherd).
- Visibility: **private**. Use an authenticated clone and local link; no public release is implied.
- Topic: `herdr-plugin`. Private repositories are not discoverable through the public marketplace.
- The root MIT license and the vendored anti-slop MIT attribution/notice are included.
- `.gitignore` excludes local notes, obsolete screenshots, runtime state, environment files,
  credentials, and dependencies. These do not belong in the initial source snapshot.

## Before a public release

- [ ] Complete the operational review above, or narrow the declared compatibility accordingly.
- [ ] Review source/history for private data before deliberately changing repository visibility.
- [ ] Keep manifest/package versions consistent and retain the dependency lockfile.
- [ ] Tag a reviewed release and verify direct Herdr installation against that revision.
- [ ] Update the README's private-repository instructions only after public installation succeeds.
- [ ] Confirm marketplace discovery after publication. Discovery refreshes about every 30 minutes;
      listing is not security vetting.
- [ ] Announce this as an alpha with explicit session-local state, legacy-lock migration, monitoring-off
      default, remote limitations, configured-not-effective keymap, and subscription recovery gaps.
