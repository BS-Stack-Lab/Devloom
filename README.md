# Devloom IDE local P0

A private macOS arm64 development bootstrap of Code - OSS with a TypeScript extension and a Rust child process. Own code is MIT. Upstream notices and identity files remain intact; this is not a signed distribution or a license approval for bundled dependencies.

The fixed source is Code - OSS 1.146.0 at `69047191fc427f2f92828279aae1d90d8eeda7ab`. `upstream.lock.json` records source and tool pins. Source acquisition, dependency licenses and build provenance live in the external workflow evidence directory. `vendor/`, `.tools/`, `design/` and `p0-spike/` are local ignored inputs.

## Local prerequisites

Use Node 24.22.1, pnpm 12.16.0, Rust 1.100.0, Xcode command line tools and the pinned Code - OSS checkout under `vendor/code-oss`. Install its dependencies and Electron using its own contributor instructions. Root dependency installation uses the committed lockfile:

```sh
pnpm install --frozen-lockfile
node scripts/devloom.mjs prepare
cargo build --manifest-path crates/devloom-sidecar/Cargo.toml --locked
pnpm run build
```

When using the project-local toolchains, prepend `.tools/node-v24.22.1-darwin-arm64/bin`, `.tools/pnpm/node_modules/.bin` and `.tools/cargo/bin` to PATH and set CARGO_HOME to `.tools/cargo` and RUSTUP_HOME to `.tools/rustup` using absolute paths. Separate npm user/global configuration files are available under `.tools` for local isolated dependency installation.

## Checks and application

```sh
node scripts/devloom.mjs check
pnpm run format:check
pnpm run lint
pnpm run build
cargo fmt --manifest-path crates/devloom-sidecar/Cargo.toml -- --check
cargo clippy --manifest-path crates/devloom-sidecar/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path crates/devloom-sidecar/Cargo.toml --locked
cargo build --manifest-path crates/devloom-sidecar/Cargo.toml --locked
DEVLOOM_EVIDENCE_DIR=/absolute/external/evidence pnpm run test
pnpm run upstream:build
pnpm run test:extension
DEVLOOM_EVIDENCE_DIR=/absolute/external/evidence pnpm run test:profiles
```

`upstream:build` runs the pinned upstream `compile-client` script. It may be slow. `test:extension` requires that successful compilation and the local Electron artifact. It opens a temporary remote-less Git repository in a fresh development profile, invokes the contributed Verify command without explicit extension activation, tests the real Rust helper and bundled `vscode.git`, and removes the temporary profile. Set `DEVLOOM_EVIDENCE_DIR` to an absolute writable parent outside this repository for evidence. Every invocation creates a unique `session-*` subdirectory containing the raw log, `result.json` and `launcher-result.json`; it preserves existing files and previous sessions. The launcher prints the exact successful result path, and `launcher-result.json` records it. An external evidence parent is required. Execution has a 90 second deadline and only its own process group is terminated on cleanup.

`pnpm start` opens the ordinary Workbench with a persistent namespace at `.tools/dp/<token>/u` (extensions are its sibling directory). Select a name with `pnpm start -- --dev-profile work /absolute/workspace` or `DEVLOOM_PROFILE=work pnpm start`. The token is the first 16 lowercase hexadecimal characters of SHA256 of the full ASCII ID; ownership markers retain that full ID and canonical repository root, and mismatches/collisions are refused. The CLI selector takes precedence over the environment, then `default`. IDs use lowercase ASCII letters/digits, underscore or hyphen, start with a letter/digit and contain at most 48 characters. An optional existing local workspace directory is accepted; other options and native storage-routing flags are refused before preparation or profile writes. Without a workspace argument, native ordinary empty/last-workspace behavior applies.

Before preparation or any profile/overlay write, start checks canonical native Main and reserved shared IPC socket paths in UTF-8 bytes, using the pinned version/type prefixes. Each must be below the conservative macOS limit of 103 bytes; a failure requires a shorter checkout path and never relocates data automatically. Current checkout paths use 99/101 bytes. Existing `.tools/devloom-development-profiles` data is left untouched; no migration or adoption is performed.

Only exclusive first creation writes privacy defaults. Reusing a profile preserves existing JSONC settings and native global/workspace state, even when settings were deliberately removed. Marked owner-only namespaces are required; unknown, incomplete, symlinked, foreign-owned or unsafe paths fail closed and remain intact. Concurrent initialization may require a safe retry after the creator finishes. Inspect incomplete paths manually, move them if appropriate and choose another name; the launcher never adopts, repairs, unlocks or deletes them. These ownership checks are not an OS sandbox against malicious same-user replacement.

Manual start has no application deadline or cleanup/kill policy. Native IPC owns same-profile handoff and application lifetime. A second same-profile start focuses the existing workspace window and may return while Main remains alive. Normal start supplies neither `--new-window` nor `--reuse-window`; native preferences control opening another workspace and restoring prior windows. Persistent windows use ordinary native hot-exit backups. Exact dirty editor contents and multiline SCM drafts were verified across clean quit/reopen in owned fixtures; sudden-crash durability and untitled-only recovery remain unverified. The separate `test:extension` profile remains disposable.

Persistent start builds an offline local VSIX from the explicit own compiled JavaScript payload and unchanged MIT LICENSE, then invokes the pinned Electron `out/cli.js` native installer from the canonical Code OSS checkout. It verifies native install/list/location, registry and installed bytes before opening a window. Normal GUI start stays on native `code.sh`; extension-development/test/debug flags are absent. The archive includes source-root/pinned-source provenance and no dependencies, workspace data or Rust binary. Build own code explicitly before start. This local native installation is not a signed Marketplace/distribution package.

An exclusive profile install lock and receipt prevent adoption or overwrite of unknown own-ID extensions, native partial installations or stale preparation. An unchanged verified payload is reused even with a live Main; a changed trusted payload requires a cleanly inactive profile. Failures preserve pending metadata, native partials and bounded-child logs under `.tools/local-vsix` for inspection, and refuse application launch. Inspect ambiguous state manually; no automatic unlocking, registry repair, live reload or Main termination occurs. Other extensions and enablement preferences are preserved. Fresh profiles use the pinned native `extensions.autoUpdate='off'` value; native Workbench may migrate an obsolete existing boolean setting during application startup, independently of the installer's preservation checks. A deliberately disabled bootstrap stays disabled; use the native Extensions UI to enable it explicitly before invoking its commands.

`DEVLOOM_EVIDENCE_DIR=/absolute/external/evidence pnpm run test:normalInstall` exercises actual native local installation/reuse/update, isolated CLI callers, corrupt-archive failure, production command-palette activation and Rust echo, and actual backup-write failure with native OK/keep-editing veto followed by clean recovery. `pnpm run test:commitState` uses the same external evidence setting for rendered native Git warnings, history, failing/held hooks and exact H/index/disk/buffer/draft checks. Only nonce-owned fixtures and process groups are cleaned up; logs remain external. Fake installer unit tests are separately labeled and do not substitute native evidence.

The exact runtime overlay sets `nameShort`/`nameLong` to Devloom IDE, `applicationName` to `devloom` and `dataFolderName` to `.devloom`; development runtime adds ` Dev` and `-dev`. Raw upstream product identity/notices and source Electron bundle remain intact. This does not register OS associations or URL protocols. Initial privacy settings and each-launch telemetry/update/account/AI disable controls remain; existing preferences are not rewritten and this is not a guarantee against every network endpoint.

`test:profiles` requires the compiled local app and root build plus an existing absolute external evidence parent. It exercises the actual start CLI with nonce-owned A/B profiles and a fixture-only installed companion: native settings/Memento write, clean quit/reopen, isolation, concurrent independent Mains, ordinary same-workspace follower focus and different-workspace activation and B-before-A native quit. Every invocation preserves raw logs, stage results and `run-result.json` in a unique external session. Stages have 45 second bounds and the suite 240 seconds. Only captured test-owned process groups may be terminated on failure. Fixture removal requires its nonce/marker and confirmed Main exit; ambiguity preserves paths and reports leftovers. Normal profiles are never cleaned by the suite. The existing shared Git broker's owner-loss and manual-recovery boundaries remain unchanged.

## Commands and lifecycle

- `Devloom: Verify Local Bridge` starts the helper, negotiates protocol 1.0, and verifies a Unicode echo.
- `Devloom: Restart Local Bridge` explicitly stops the old child before starting a new generation.
- `Devloom: Stop Local Bridge` waits for shutdown and reaps the owned child.

The Devloom output channel reports lifecycle results without payloads. A crashed helper rejects outstanding requests; explicit restart recovers without replay. Deactivation waits for stop. The installed bootstrap requires the launcher-provided canonical `DEVLOOM_APP_ROOT`, validates its pinned source identity and installed provenance, and resolves only the fixed crate build helper under that root. Invalid explicit roots fail; there is no opened-workspace or PATH fallback. Disposable development/test hosts retain their exact source-extension fallback. No workspace executable, network, login, cloud or mobile integration is added.

The private JSON-RPC profile uses bounded Content-Length frames, 64 KiB bodies, 1024 byte headers, 8192 byte echo strings and at most 16 pending requests. Cancellation and timeouts settle once. Invalid transport data closes the connection. Stop first requests shutdown, then closes stdin and escalates TERM/KILL within deadlines. Parent death closes the helper's stdin, including during a partial frame.

## Failure diagnosis

A source/tool mismatch from `check` requires restoring the recorded checkout and tool versions. Do not change the immutable pin to make checks pass. A missing helper requires the Cargo build above. Build or host failures are failures until rerun successfully; inspect the raw log and structured result, including process IDs and application name. Fake child tests validate failure handling separately from the actual Rust boundary.

This P0 does not include account integration, Marketplace access, a production update service, packaging, signing, cross-platform validation or a full redistribution license/BOM gate.

## Local Git foundation

`Devloom: Diagnose Local Git` reports the discovered Git executable/version, local author-identity presence, workspace trust and shared coordinator state. It offers the existing Source Control view and Git output. Diagnostics never change global author settings. Git 2.28 or later is required for writes; the tested runtime is Git 2.53.0 on macOS arm64.

The bundled native Git extension remains the only SCM provider and Git writer. Use its existing init/clone, staged and working-tree diff, selected-range stage/unstage, multiline commit, branches, tracking, fetch/pull/push and merge UI. The Rust bridge does not execute Git. Own coordinator modules compile to root `dist/product/localGit` and load from the fixed development app root; a packaged distribution layout is outside this bootstrap.

Native Git execution refuses inherited repository/index/object/ref/config routing overrides, including `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE` and injected config vectors. Remove unsupported overrides before retrying. Inline configuration is restricted to the pinned native encoding, identity and read-only ignore-query settings. Normal askpass, SSH agent/command and HTTP user-agent environment remains intact.

All native IDE mutations reserve one conservative queue per OS user, shared across windows, profiles and linked worktrees. Requests carry the reviewed HEAD/index snapshot and model generation; changed requests fail with a refresh/review action. Selected-content requests also retain document versions and gutter baseline provenance. Status uses `GIT_OPTIONAL_LOCKS=0`. Git's own locks remain authoritative for external terminals and other applications, which are outside the coordinator.

An owner-only Unix socket and durably flushed ownership journal record active work before granting a lease. The lease stays reserved until every tracked native Git child closes. Hook failures retain staged/worktree bytes and report the native error; retry remains explicit after review. Mutable native lock retries recheck the original snapshot. No hook bypass, forced cleanup or Git lock deletion is introduced.

Ambiguous cancellation, extension-host loss or Main loss fails closed. An active journal survives restart as quarantine; a stale endpoint also refuses writes. There is no automatic replay, timeout/PID-based unlock or automatic quarantine recovery. Manual recovery requires inspecting OS processes, hooks/descendants and repository state to establish that no writer remains. Restart alone proves nothing. Never remove Git-owned lockfiles as a coordinator recovery shortcut. A broker-owning Main that exits can interrupt follower profiles; reopen only after clean ownership has been established.

Snapshot reads currently support traditional loose/packed refs. Reftable and nested symbolic branch refs are refused before writes. Index hashing streams bounded chunks and refuses indexes over 256 MiB; individual HEAD/ref metadata files over 16 MiB are also refused. These explicit boundaries require a supported reader before widening support.

Run the real Git fixtures after the pinned native build:

```sh
DEVLOOM_EVIDENCE_DIR=/absolute/external/evidence pnpm run test:localGit
```

Each invocation creates a unique evidence session, disposable repositories and bare remote, separate app profiles and a short private test socket directory. Development-only fixture namespaces do not replace the normal per-user endpoint. Only test-owned process groups and fixtures are cleaned up. The host scenarios inspect actual Git objects/index bytes, selected diff-editor commands, merge conflicts, hooks, external lock handling, shared-window serialization, linked-worktree aliases, A/B routing refusal, controlled native clone cancellation and crash refusal; raw failures remain evidence until a successful rerun. Controlled API cancellation uses the same native clone/exec cancellation path as the UI and verifies child-close ordering, preserved existing files/index, actual partial-destination cleanup, durable quarantine and follow-up refusal. User-visible UI cancellation remains a separate QA check. Unit tests separately exercise bounded framing, lease ownership, stale snapshots, endpoint validation, durable quarantine and exact patch application.

Tracked patches under `patches/localGit` target the immutable upstream SHA. Prepare/build verifies payload, preimage and postimage hashes, applies pristine sources deterministically, accepts an identical second application and rejects partial application or unrelated source drift. Never repin upstream or edit ignored native sources independently of their tracked patches.

The authenticated transport fixtures below use local endpoints only. Sudden-crash draft durability, untitled-only recovery, other operating systems, signed distribution packaging and automatic manual-recovery tooling remain outside this implementation.

For independent QA, set `DEVLOOM_LOCAL_GIT_SCENARIOS` to a comma-separated subset of `normal`, `concurrency`, `linked-worktree`, `untrusted`, `missing-git`, `unsupported-git`, `worker-crash`, `main-crash`. Unknown, empty and duplicate names are refused. The default remains all eight scenarios; `run-result.json` records the exact selected/completed groups and identifies subset runs, which do not replace the full mandatory suite.

## Component inventory

```sh
DEVLOOM_EVIDENCE_DIR=/absolute/external/evidence pnpm run inventory:components
pnpm run test:components
```

The inventory currently requires Git 2.53.0 at `/opt/homebrew/bin/git`. Other executable locations and versions are unsupported by this inventory command; the local Git runtime write minimum of Git 2.28 above is a separate requirement. No global Git configuration changes are needed. Support for other installed Git locations can be added through a future tool discovery improvement.

The inventory verifies the fixed source and applied patches without applying patches or changing Git configuration. It scans component manifests, license/notice evidence, installed root and upstream packages (including declared workspaces and extension dependencies), downloaded extension declarations, specified native artifacts, local Electron bytes and own Rust dependencies using offline locked Cargo metadata. It does not attest every source file. Archive checksums, original source hashes and actual local file hashes are separate evidence. Native files are hashed without execution; runtime loading, distribution and build provenance remain unknown where unobserved.

Every invocation requires an absolute evidence parent outside this repository, rejects repository aliases, and creates a unique `component-inventory-*` session with an exclusive `inventory.json`. The report contains stable sorted content and its SHA256 `contentDigest`; session time and output paths do not affect that digest. Repeated scans with unchanged inputs produce matching content. stdout names the report, digest and three independent states: `scanCompleteness` (`complete` or `incomplete`), `licenseCoverage` (`complete`, `partial` or `unknown`) and `legalApproval` (always `not-assessed`). Missing license evidence is recorded without assuming MIT or granting redistribution rights.

Exit 0 means collection completed, including when license coverage is partial. Exit 2 preserves a report with incomplete collection, such as missing required inputs, invalid component manifests, offline cache failures or bounds reached. Exit 1 means an argument/output, source pin/integrity, patch or Git policy failure prevented a trustworthy inventory. No exit code grants legal approval. Restore required local inputs or inspect safe diagnostic codes before retrying; the command never installs dependencies or fetches objects.

Scanning is bounded to 500000 directory entries, depth 32, 8 MiB manifests, 64 MiB license files, 1 GiB binary files, 8 GiB total hashed bytes and 32 MiB/30 seconds per metadata subprocess. Symlink resolution is limited to explicit component roots; unsafe links and unsupported metadata are reported. Known fixed identity text may compare CRLF worktree bytes against LF source bytes using a built-in comparison; reported hashes always retain the original raw bytes. These checks do not provide an OS sandbox against concurrent filesystem replacement, a complete binary dependency graph, a distribution BOM or legal approval. Current execution validation covers macOS arm64 only.

## Command and requirement catalog

```sh
DEVLOOM_EVIDENCE_DIR=/absolute/external/evidence node scripts/commandCatalog.mjs
node --test tests/commandCatalog*.test.mjs
```

The offline catalog uses the same pinned Node 24.22.1 and read-only Git 2.53.0 policy as the component inventory. It verifies six immutable manifest/NLS hashes for the fixed git, github and github-authentication extensions before enumerating 192 command declarations, 113 settings, 454 menu entries and 9 submenu definitions. Raw payload order, JSON pointers, labels and reference context remain traceable. Other contribution points are explicitly deferred. These are source declarations; runtime registrations and observed UI behavior need separate verification.

The tracked requirement snapshot preserves 160 Git/GitHub requirements from the original 200, excludes RD40 and retains original acceptance, verification IDs, phases and planned status. Exact source decisions link relevant requirements and declared menu contexts. Reviewed relationships that need further evidence remain unmapped for follow-up in #13; unlinked requirements remain unverified. The scoped `p0MappingGate` remains `not-passed` while source relationships or labels are unresolved. This does not certify all P0 requirements, implement GitHub functionality or perform the IntelliJ comparison.

Each invocation requires an absolute external evidence parent and creates a unique `component-inventory-*` directory through the shared evidence helper, containing an exclusive mode-0600 `catalog.json`. Existing sessions are preserved. `contentDigest` covers stable content while preserving ordered arrays; session timestamps and paths are excluded. stdout reports the path, digest, `collectionCompleteness`, `mappingCoverage`, `runtimeVerification` (always `not-assessed`) and scoped gate.

Exit 0 means trustworthy complete enumeration, even when mapping coverage is incomplete. Exit 2 preserves partial extraction from verified bytes with explicit shape, identity, count or local-submenu diagnostics. Exit 1 means a mandatory input, immutable provenance, mapping contract, Git policy, argument or output failure; no trustworthy successful report is produced. Missing NLS tokens keep enumeration complete but block mapping. The CLI never installs, fetches or mutates Git configuration. Dedicated catalog tests above are required separately from the existing root `pnpm run test` suite.

## Commit draft and unsaved editor behavior

Native SCM history owns multiline commit messages, templates and unsubmitted drafts. A failing pre-commit hook and Cancel on the rendered native unsaved-file warning retain the draft and all H/index/disk/buffer contents without retry. Native Git may refresh an unprimed index's cache metadata while retaining staged modes and object IDs; raw index byte equality in these fixtures is asserted after an explicit prelaunch dry-run stabilizes that metadata. It is not a universal byte-identity promise. Explicit retry remains required. A successful commit resets the input to the current native template.

For eligible dirty tracked documents, **Commit Changes** commits the staged index I while retaining dirty buffer B and disk D. **Save All & Commit Changes** saves B and re-adds eligible staged files, replacing partial staging in those files. **Cancel** makes no commit. The warning includes multiple eligible staged dirty files, but excludes unstaged-only dirty documents when staged entries exist, out-of-repository documents and untitled editors. Setting `git.promptToSaveFilesBeforeCommit` to `never` suppresses that warning and commits I. These observed native boundaries are not a warning guarantee for every editor or command. Native backup errors offer OK to keep editing; Quit Anyway permits native forced shutdown and was not selected in verification.

## Authenticated local transport fixtures

```sh
DEVLOOM_EVIDENCE_DIR=/absolute/external/evidence pnpm run test:gitTransports
```

This fixture suite requires the pinned ordinary Workbench, locally installed nonce-owned companion and bundled native Git extension. It exercises loopback HTTPS Basic authentication through the exact-host native CredentialsProvider and genuine unprivileged current-user OpenSSH public-key authentication. TLS certificate chain and IP SAN checks and pinned SSH host-key verification stay enabled. Credentials, keys and child-only Git/SSH configuration remain private; user configuration, agents, Keychain and system services are untouched. A host that cannot safely run the native daemon fails the required SSH cases.

The runner asserts native clone/fetch/pull/push SHA outcomes, authentication and trust rejection, separate API and rendered-progress cancellation, authenticated interruption and authoritative pre/post-update push outcomes. Terminal Git initializes fixtures and independently reads state; it does not substitute for IDE operations. HTTP unit backends are synthetic evidence only. Newly created partial clone targets are recorded, while preexisting targets and sentinel bytes are protected. Ambiguous or rejected backend obligations preserve private spools and fail shutdown; no journal, Git lock or profile repair occurs. Every attempt keeps its own external result and sanitized logs. Completion applies only to cases actually reported PASS, with no overall P0/P1, parity, external-account or distribution claim.

## P1 acceptance evidence

The default `test:localGit` remains the original eight groups with 100 second group deadlines. Additional targeted native fixtures are opt-in and have 180 second group deadlines:

```sh
DEVLOOM_EVIDENCE_DIR=/absolute/external/evidence DEVLOOM_LOCAL_GIT_SCENARIOS=p1-changes pnpm run test:localGit
DEVLOOM_EVIDENCE_DIR=/absolute/external/evidence DEVLOOM_LOCAL_GIT_SCENARIOS=p1-sync pnpm run test:localGit
DEVLOOM_EVIDENCE_DIR=/absolute/external/evidence node --test tests/p1Coverage.test.mjs tests/p1CoverageEvidence.test.mjs tests/localGitAutofetch.test.mjs tests/localGitSession.test.mjs
DEVLOOM_EVIDENCE_DIR=/absolute/external/evidence node scripts/p1Coverage.mjs
```

Build own TypeScript before dist consumers and compile the pinned native application before native fixtures. `run-result.json` distinguishes the selected/completed groups, original full suite and targeted P1 completion. Native automatic fetch requires a new fetch child start and matching close after lease release and focus opportunity; a timeout fails with diagnostics.

The read-only report preserves all 28 original P1 rows and their 87 conjunctive clauses, including original `planned` status. Set `DEVLOOM_P1_EVIDENCE_INDEX` to an external coordinator or QA index for source-bound producer evidence admission. No index produces an explicit unverified inventory. Malformed, stale, foreign or unsafe evidence fails the report command. Exit zero means report generation succeeded; it does not certify whole P1 acceptance. Native API, rendered observations, physical interaction, fixture CLI, static and historical evidence remain distinct. Missing physical controls, account features, selected remote/ref interaction, history navigation and visible baseline timestamps remain explicit gaps unless independently observed and admitted.

Launcher regression tests use real owned Node children, marker/OS process identity checks and an independent sentinel. Injected probe failures validate harness safety; they do not certify native application startup. Ambiguous ownership preserves exact fixture/profile leftovers without signaling or adopting them. Process snapshots and nonce markers are best-effort local ownership checks, not atomic process handles or an OS sandbox against same-user races.

## Offline RPC baseline

Use the pinned macOS arm64 Node 24.22.1, pnpm 12.16.0, Rust 1.100.0 and Git 2.53.0 at `/opt/homebrew/bin/git`. Configure the project-local PATH, CARGO_HOME and RUSTUP_HOME as described above. Existing root/upstream dependencies and Rust caches are required; the runner never builds, installs, fetches or applies patches. Build the current own TypeScript and fixed debug helper first:

```sh
pnpm run build
cargo build --manifest-path crates/devloom-sidecar/Cargo.toml --locked --offline
DEVLOOM_EVIDENCE_DIR=/absolute/external/evidence node --test tests/rpcBenchmark.test.mjs
DEVLOOM_EVIDENCE_DIR=/absolute/external/evidence node scripts/runRpcBenchmark.mjs
```

The runner accepts no arguments or executable overrides. It verifies the source with the inventory's read-only Git policy. The measured experiment has a 60 second deadline; preflight commands have separate bounds and every owned helper is stopped in finally. Only its fixed debug helper is executed.

Five repetitions alternate mode order, with a fresh helper per repetition. Empty, fixed Unicode, 1024 byte ASCII and 8192 byte ASCII inputs use identical sequences in both modes at concurrency 1 and 16. Each cell excludes 20 warmups and records 100 measured operations: 8000 measured requests and 1600 warmups total. Sequential batches include final partial batches and never exceed 16 outstanding requests.

`ts-only-in-process` is a small asynchronous Node JavaScript echo using the existing compiled TypeScript validators. `rust-stdio` includes the actual bridge, serialization, framing, pipes, scheduling and debug helper. This measures architectural boundary cost, with common result validation/equality checking inside both latency intervals. It is not an isolated language-speed comparison and reports no Rust speedup.

Each cell retains individual raw request latency, wall duration and completed-count/wall throughput. Nearest-rank p50/p95/max summaries group only the same mode, input and concurrency. Zero wall duration makes throughput unavailable. Warmups never enter distributions. There is no performance pass/fail threshold; five local repetitions do not establish statistical significance. V8/JIT/GC, shared runner history, machine load and OS caches remain uncontrolled; fresh process startup does not mean cold OS caches.

Actual helper start/hello, restart/generation, timeout settlement and stop/reap observations accompany pending cleanup checks. Cancellation measures abort-to-local-promise settlement after a separately recorded dispatch-to-abort delay; remote acknowledgement/completion is unavailable. A following echo proves responsiveness only. The client lifetime envelope is not exact OS CPU lifetime. TS startup/restart/lifetime are not applicable.

Boundary RSS samples retain process, phase, units and method. Node RSS includes the shared runner and retained raw samples; helper RSS uses the current owned pid and macOS `/bin/ps` 1024-byte units. Missing/replaced/probe-failed helper samples are unavailable and set `memoryCoverage` to `incomplete`, independently of functional outcome. These are neither peaks nor isolated per-mode allocations, process-tree totals or whole-IDE memory.

Every invocation creates a unique external `component-inventory-*` session through the shared evidence helper. Exclusive mode-0600 `raw.jsonl` and `benchmark.json` preserve prior sessions and partial failures. The report identifies ordered input/config digests, source/tool versions, required source/compiled hashes and debug executable bytes before/after execution. `observed-local-bytes` is not reproducible-build attestation; debug-path compiler/profile overrides remain unobserved unless separate current build logs establish them.

Exit 0 means all functional measurements, owned cleanup and required provenance checks succeeded. Exit 1 preserves a failed report after safe session allocation, or prints a safe error code if allocation was refused. Interrupted runs may have only partial raw evidence and never imply success. stdout names the exact report path, outcome and configuration digest. Read both outcome and memory coverage before interpreting a report.

This Node-only baseline measures no renderer, extension host, Electron UI blocking, GitHub latency or native UI. It makes no packaging, cross-platform or overall P0 completion claim. Synthetic failure tests are labeled separately and do not replace full actual helper runs.
