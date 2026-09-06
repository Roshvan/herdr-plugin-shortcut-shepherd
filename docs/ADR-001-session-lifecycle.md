# ADR 001: Explicit session ownership and conservative attribution

Status: accepted for 0.2.0-alpha.1.

## Context and existing seams checked

Herdr installs plugins globally, shares their config/state roots across sessions, and invokes
startup hooks per server. Hooks are one-shot initialization, not daemon supervision. The previous
`plugin-files.ts` mixed persistence with a global PID lock; `actions/watcher.ts` detached a process
without observing readiness. `stop.ts` signalled whichever process happened to have the saved PID.

We inspected/reused the existing JSON, Herdr socket, CLI, input-monitor, keymap, inference, policy,
and Shepherd modules. The functional inference/policy core remains. The change does not introduce
another framework, database, or generic plugin SDK.

## Decisions

### Ownership is an OS-held endpoint, not a PID

`plugin-files.ts` now owns only storage paths/parsers/persistence. Mutable state is session-local;
shared `config.json` remains the user's cross-session policy. Session identity hashes the plugin ID,
state root, and injected Herdr socket path. No fallback to a guessed default Herdr socket is allowed.

`watcher-control.ts` is a distinct boundary because process lifetime, authentication, and bounded
request serving change for different reasons than JSON persistence. It reuses the bounded
`requestOnce` socket adapter for clients. One deterministic 127.0.0.1 TCP port is bound exclusively
per session. The kernel releases it on death, eliminating stale PID files, PID reuse, and filesystem
lock reclamation races. Collision with another application fails closed and is reported.

We considered Unix-domain sockets, lock directories with stale leases, and PID/start-time checks.
Unix stale-socket unlink/rebind and stale directory reclamation have races; PID identity/signal
handling also differs across supported OSes. A loopback endpoint works on all target platforms
without unsafe stale-lock deletion or process inspection. The trade-off is a possible derived-port
collision and a private loopback listener. There is deliberately no fallback to another port: two
simultaneous contenders must not each "recover" onto different ports and become duplicate watchers.

A 256-bit private secret is published by creating a complete 0600 temporary file and linking it
create-if-absent. Concurrent starters read the same complete immutable key. Directory/file protection
also matters: Unix private modes and Windows user-profile ACLs. The key is redacted in printable
representations and only unwrapped at the transport boundary. Every request authenticates the key
and session; stop additionally checks the running instance's random identity. PIDs are informational.

### Startup/shutdown are acknowledged operations

The manifest runs `actions/start.ts`, a one-shot launcher. The child acknowledges readiness only after
it owns the control endpoint, parses config/state, subscribes, and obtains an initial Herdr snapshot.
Concurrent contenders wait for the authenticated winner rather than creating a second writer.

A stopping instance rejects new mutations, drains earlier serialized work, saves pending stats,
stops its input helper, cancels streams/timers, and releases ownership. A failed final save retains
ownership/state and reports failure so the user can repair storage. Startup no longer equates
successful spawn with successful startup; stop no longer equates sending a signal with completion.

The host still does not supervise daemon lifetime. Users must stop each session before disabling or
uninstalling. Legacy PID locks deliberately require human verification and removal; the new code
will neither signal their contents nor pretend old ambiguous counters have precise attribution.

### One writer per session, explicit failure contracts

`watcher-commands.ts` owns pause/mute/reset/refresh operation policy through narrow application ports.
`watcher-runtime.ts` assembles adapters and binds event/timer lifecycle. All mutable session operations
share a serial executor. The UI/actions use the control channel rather than editing files.

Shepherd's persistence port returns `Result`; failed writes stay dirty, overlapping flushes are
serialized, and an old completed save cannot mark a newer revision saved. Atomic replacements use
unique private temporary files. Corrupt startup state is left untouched and reported. These files
are periodic snapshots, not a power-loss-proof event journal.

Socket adapters bound connect/response time, line size, and subscription backlog. CLI adapters bound
child time/output and only terminate child handles they created. Expected failures are values at the
owning boundary. A subscription lease rotates even quiet streams, followed by replay warm-up and a
successful resnapshot before counting; activity during this conservative recovery can be missed.

### Attribution is a capability, not inferred certainty

Monitoring defaults off. Unknown events are counted separately and never nudge or count as keyboard
success. The optional local macOS helper estimates preceding global input only; future typing no
longer changes past attribution and near-ties remain unknown. Input histories are regularly pruned.
The popup says Mouse~/Keys~/Unknown rather than claiming verified shortcut hits or slow use.

SSH/remote clients are not observable through the server's OS helper. Even local estimates can mix
other applications or keyboard-driven menus with shortcut activity. Exact metrics require upstream
Herdr action/invocation provenance; this release does not manufacture it.

### Parse configuration fully; don't imply runtime verification

The handwritten TOML subset was removed from the keymap domain module. `herdr-config.ts` owns
`smol-toml` parsing/projection and redacted diagnostics. The last acknowledged keymap remains installed
on errors. Disk changes suspend nudges until the user reloads Herdr and explicitly refreshes Shepherd.
No inspected Herdr API exposes effective keymap state, so the UI calls these configured suggestions.
Legacy indexed syntax is rejected with migration guidance rather than silently guessed.

`string-width` supplies terminal-cell measurements in the presentation adapter; truncation respects
grapheme boundaries and removes control characters. These maintained dependencies are an intentional
trade-off against a zero-runtime-dependency implementation with incorrect boundary parsers/rendering.

## Static checks and release scope

The owner requested no tests. The repository contains no automated test suite, fixtures, or runner;
`pnpm check` and CI perform typecheck/lint only. CI is configured for macOS/Linux/Windows and Node
22.18/24/26, but static checks do not certify runtime behavior.

Real Herdr lifecycle/UI behavior, native Windows/Linux operation, optional macOS input estimates,
and the public repository/topic/tag still need an operational review before release. See RELEASE.md.
