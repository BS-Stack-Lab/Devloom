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

`upstream:build` runs the pinned upstream `compile-client` script. It may be slow. `test:extension` requires that successful compilation and the local Electron artifact. It opens a temporary remote-less Git repository in a fresh development profile, invokes the contributed Verify command without explicit extension activation, tests the real Rust helper and bundled `vscode.git`, and removes the temporary profile. Set `DEVLOOM_EVIDENCE_DIR` to an absolute writable directory to retain raw logs, `result.json` and `launcher-result.json`. Default evidence is ignored `.local-evidence/extension-host`. Execution has a 90 second deadline and only its own process group is terminated on cleanup.

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
