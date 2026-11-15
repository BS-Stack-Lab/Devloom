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
pnpm run test
pnpm run upstream:build
pnpm run test:extension
```

`upstream:build` runs the pinned upstream `compile-client` script. It may be slow. `test:extension` requires that successful compilation and the local Electron artifact. It opens a temporary remote-less Git repository in a fresh development profile, invokes the contributed Verify command without explicit extension activation, tests the real Rust helper and bundled `vscode.git`, and removes the temporary profile. Set `DEVLOOM_EVIDENCE_DIR` to an absolute writable parent outside this repository for evidence. Every invocation creates a unique `session-*` subdirectory containing the raw log, `result.json` and `launcher-result.json`; it preserves existing files and previous sessions. The launcher prints the exact successful result path, and `launcher-result.json` records it. An external evidence parent is required. Execution has a 90 second deadline and only its own process group is terminated on cleanup.

`pnpm start` opens a development app with the extension. It creates a fresh temporary profile and removes it after the app exits; use `test:extension` for reproducible checks. The product overlay changes only display names to Devloom IDE. The development runtime adds a Dev suffix.

## Commands and lifecycle

- `Devloom: Verify Local Bridge` starts the helper, negotiates protocol 1.0, and verifies a Unicode echo.
- `Devloom: Restart Local Bridge` explicitly stops the old child before starting a new generation.
- `Devloom: Stop Local Bridge` waits for shutdown and reaps the owned child.

The Devloom output channel reports lifecycle results without payloads. A crashed helper rejects outstanding requests; explicit restart recovers without replay. Deactivation waits for stop. The helper executable comes only from the fixed repository-relative crate build location. No workspace executable, network, login, cloud or mobile integration is added.

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

Authenticated HTTPS/SSH servers, advanced draft persistence/unsaved-buffer flows, other operating systems, packaging and automatic manual-recovery tooling remain outside this implementation.

For independent QA, set `DEVLOOM_LOCAL_GIT_SCENARIOS` to a comma-separated subset of `normal`, `concurrency`, `linked-worktree`, `untrusted`, `missing-git`, `unsupported-git`, `worker-crash`, `main-crash`. Unknown, empty and duplicate names are refused. The default remains all eight scenarios; `run-result.json` records the exact selected/completed groups and identifies subset runs, which do not replace the full mandatory suite.
