# Operating the personal T3 fork

Source: https://github.com/nobody0/t3code. Upstream: https://github.com/pingdotgg/t3code.
KO stores knowledge and fleet intent; T3 owns projects, worktrees and execution.
Use direct Tailscale pairing. Caps is the primary environment at its own origin;
PC, Mac and Klarstand are its three saved remote connections.

## Source and publication

The maintained checkout is KO's integrations/t3-code submodule. The obsolete
standalone checkout and receiver are removed. KO already tracks the gitlink.
Upgrade work uses upgrade/ko-0.0.44, based on upstream v0.0.44 at
451afcb22d93f06cb24f9bc16703404564952553. That tag's source manifests still say
0.0.43; stamp the four release manifests to 0.0.44 before review.

The server repository metadata identifies this fork, which refuses upstream
update/service installation and removal commands. Status and restart remain
available; activation uses the fork manager below.

Agents leave source and KO changes unstaged/uncommitted unless the user explicitly
authorizes publishing a reviewed fork release. A production build requires a clean checkout whose HEAD
equals published nobody0/t3code main. After fleet acceptance, the user records
that published revision as KO's gitlink. Never deploy uncommitted previews.

## Build and validate

Use Node 24 and the repository-pinned package manager. The server/web release
does not require desktop, mobile, marketing or infrastructure dependencies:

    corepack pnpm --filter @t3tools/monorepo --filter @t3tools/web... --filter t3... --filter @t3tools/scripts... --filter @t3tools/oxlint-plugin-t3code... install --frozen-lockfile
    node --test scripts/ko-release.test.mjs scripts/ko-native-service.test.mjs scripts/ko-node-pty.test.mjs scripts/ko-session.test.mjs
    node scripts/build-ko-release.mjs --preview

This builds the complete server/client and packages dist/ko-session.mjs.
Patched runtime-external JS wrappers are preserved beside the bundle; npm alone
would lose pnpm patches. Native siblings install on the target platform.
No managed Connect configuration is needed. Leave VITE_HTTP_URL and VITE_WS_URL unset.

Validate previews only in disposable installations, isolated T3 homes and unused
loopback ports. The fleet installer rejects previews; never alter manifest flags
to bypass that check. Native fixtures are opt-in: KO_TEST_SYSTEMD=1 on Linux and
KO_TEST_NATIVE=1 on Mac/Windows. They use disposable service names.

After publication, run node scripts/build-ko-release.mjs without --preview.
Retain release/<id>/t3-code.tgz and release.json together. The manifest records
commit, version, toolchain, lockfile and archive checksums. Outputs are immutable.

## Install and activate

Copy the release plus install-ko-release.mjs, manage-ko-release.mjs and all
scripts/lib/ko-*.mjs helpers to the target, preserving their relative layout.
Compare the archive checksum with the trusted build. Run as the T3 operator:

    node scripts/install-ko-release.mjs /absolute/release /absolute/deployment/root/releases
    node scripts/manage-ko-release.mjs status /absolute/config.json
    node scripts/manage-ko-release.mjs activate /absolute/config.json RELEASE_ID
    node scripts/manage-ko-release.mjs rollback /absolute/config.json

Installation does not change services. It verifies CLI startup and a native
terminal before writing a receipt. Retain installed runtime dependencies and
their lockfile; the archive alone is not an exact native rollback.

Keep config.json outside the live T3 home. Config keys are platform, root,
baseDir, node, unitDirectory, service, port (3773), baselineVersion ("0.0.44").
Verify these documented paths before use:

| Field         | Linux roots                       | MacBook                                         | Windows                                     |
| ------------- | --------------------------------- | ----------------------------------------------- | ------------------------------------------- |
| platform      | linux                             | darwin                                          | win32                                       |
| root          | /home/bob/.local/share/t3-code-ko | /Users/bob/.local/share/t3-code-ko              | C:/Users/BOB/AppData/Local/t3-code-ko       |
| baseDir       | /home/bob/.t3                     | /Users/bob/.t3                                  | C:/Users/BOB/.t3                            |
| node          | /run/current-system/sw/bin/node   | /Users/bob/.nvm/versions/node/v24.20.0/bin/node | C:/nvm4w/nodejs/node.exe                    |
| unitDirectory | /home/bob/.config/systemd/user    | /Users/bob/Library/LaunchAgents                 | C:/Users/BOB/AppData/Local/t3-code-ko/tasks |
| service       | t3code.service                    | com.t3tools.t3code.service                      | t3code-ko                                   |

Windows also requires userName set to BOB-THE-SMART\BOB; escape the backslash
in JSON. Its hidden operator-login Scheduled Task has failure recovery and no
execution time limit. Linux uses lingering systemd; Mac uses login launchd and
must remain logged in and awake. Preserve provider PATH, T3 home and Tailscale routes.

Before cutover, verify idle agents/terminals and make a consistent database
backup plus required settings/secrets. Test migrations only on an isolated copy:
0.0.44 adds migrations 050–054 relative to the 0.0.40 fleet and folds legacy project settings. Do not start a
full cloned server against real worktree paths: startup can reconcile worktrees
or resume agents. Per-project continuation and persisted update-continuation
markers both matter; a global opt-out alone does not suppress those markers.
Fresh-home smoke tests do not validate existing-data migration. Review recovery before changing baselineVersion.
Roll out Windows, Mac, Klarstand, then Caps; verify paired access between stages.

First Windows installation requires the old listener stopped by its verified PID
and the port free. Never broadly kill Node processes. After replacement succeeds,
remove only the obsolete temporary bunx directory. Until cutover the existing
Windows 0.0.40 process remains in place.

Activation validates isolated startup, saves recovery state, and replaces the
intended service. Linux uses a current symlink/drop-in; Mac/Windows use current.json
and save the previous service definition. Failure restores the previous service.
A pending transaction blocks activation; retry rollback. First native-install
rollback removes the newly created service. Inspect a stale lock's recorded PID
before removing that exact lock.

Binary rollback does not restore migrated data. Keep consistent backups until
acceptance; any data restore requires the associated service stopped. Retain the
previous verified installation. Caps' original clean 0.0.40 client backup remains
until the packaged upgrade is accepted.

## Health and task launches

Check service status, local /.well-known/t3/environment, browser assets, Tailscale
Serve and HTTPS. A descriptor is not provider readiness. Never reset Tailscale
Serve globally: Caps also exposes the communications hub and remote browser.

Read the installed helper's usage:

    node /release/node_modules/t3/dist/ko-session.mjs --help

Its check takes explicit --home-dir, --origin (local loopback), --environment-id
and --t3-command (JSON argv containing installed Node/CLI paths). Compare identity
with the intended deployment. It rejects stale runtime records, authenticates
briefly, checks providers and revokes temporary credentials.

Its start takes JSON from a file or stdin, uses the saved project provider/model
unless supplied, and defaults to an isolated worktree with approval-required
execution. It uses normal T3 orchestration. Supply self-contained context:
remote agents cannot reach another device's localhost. Preserve request IDs and
receipts across retries; accepted is not running. The five-paragraph t3-work
skill owns the agent workflow.

## Future upstream updates

Review an upstream release on an update branch, carry the small fork changes
forward, stamp versions and repeat focused tests and packaged-runtime checks on
each platform. Review migrations and exercise recovery. Publish the reviewed fork,
build once, activate explicitly, then update observed deployment facts through
KO's API. Do not use t3 update or temporary @latest packages for this fleet.
