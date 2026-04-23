# Tapsmith

Mobile app testing framework with a Playwright-inspired API. Three-tier architecture:
**TypeScript SDK** (test runner + assertions) → **gRPC** → **Rust daemon** (tapsmith-core) → **ADB/simctl + socket** → **On-device agent** (Android: Kotlin/UIAutomator2, iOS: Swift/XCUITest).

## Project structure

```
packages/tapsmith/        # TypeScript SDK — selectors, element handles, assertions, runner, CLI
packages/tapsmith-core/   # Rust daemon — gRPC server, ADB/simctl bridge, device management
agent/                    # Android Kotlin agent — UIAutomator2 instrumentation
ios-agent/                # iOS Swift agent — XCUITest instrumentation
proto/tapsmith.proto      # gRPC contract (single proto file, buf for linting)
npm-packages/             # Platform-specific npm packages (@tapsmith/core-{os}-{arch}) for daemon binary distribution
docs/                     # User-facing documentation
test-app/                 # React Native (Expo) test app for E2E testing
e2e/                      # E2E test suite run against the test app
```

Each component has independent dependencies and build lifecycle (not a JS monorepo).

## Build & test commands

### TypeScript SDK (`packages/tapsmith/`)
```bash
npm ci                  # install deps
npm run typecheck       # tsc --noEmit
npm run lint            # eslint
npm run test            # vitest run (unit tests, no device needed)
npm run knip            # unused code detection
npm run build           # tsc → dist/
```

### Rust daemon (`packages/tapsmith-core/`)
```bash
cargo fmt -- --check    # formatting
cargo clippy -- -D warnings  # lint (warnings are errors)
cargo test
cargo build --release
```
Requires `protobuf-compiler` installed for tonic-build.

### Android agent (`agent/`)
```bash
./gradlew assembleDebug
./gradlew ktlintCheck
```

### iOS agent (`ios-agent/`)
```bash
cd ios-agent && ./create-xcode-project.sh    # first time only
# Simulator build (unsigned, builds once per iOS version):
xcodebuild build-for-testing \
  -project TapsmithAgent.xcodeproj \
  -scheme TapsmithAgentUITests \
  -destination 'platform=iOS Simulator,name=iPhone 16'
# Physical device build (signed via the Tapsmith CLI, one-time per device/profile):
npx tapsmith build-ios-agent                    # auto-detects team ID from Xcode
```

See `docs/ios-physical-devices.md` for the full physical-device walkthrough.

### Proto (`proto/`)
```bash
buf lint proto/
buf breaking proto/ --against '.git#ref=origin/main,subdir=proto'
```

## CI

GitHub Actions runs 4 parallel jobs: `proto-lint`, `typescript`, `rust`, `android`. All must pass. See `.github/workflows/ci.yml`.

## npm packaging & releases

Releases are triggered by pushing a `v*` tag (e.g., `git tag v0.2.0 && git push --tags`). The release workflow (`.github/workflows/release.yml`) builds and publishes:

- **`@tapsmith/core-{darwin,linux}-{arm64,x64}`**: Platform-specific packages containing only the prebuilt `tapsmith-core` binary. Listed as `optionalDependencies` so npm auto-installs only the matching platform.
- **`tapsmith`**: Main package. Bundles the TypeScript SDK, CLI, proto file (`dist/proto/`), Android agent APKs (`dist/agents/android/`), and trace viewer/UI mode web apps.

**Binary resolution** (`daemon-bin.ts`): Uses `require.resolve()` to find the platform package, with fallbacks to monorepo builds, `TAPSMITH_DAEMON_BIN` env var, and `PATH`.

**Agent APK resolution** (`agent-resolve.ts`): Checks bundled APKs in `dist/agents/android/`, then monorepo build output. Config `agentApk`/`agentTestApk` override.

**Proto file** (`grpc-client.ts`): Tries `dist/proto/tapsmith.proto` (npm-installed), falls back to `../../proto/tapsmith.proto` (monorepo).

## TypeScript conventions

- **ESM with `.js` extensions** in all imports (even for `.ts` files) — required by Node16 module resolution
- **No semicolons** (ESLint enforced)
- **Strict TypeScript** — `strict: true` in tsconfig
- **`_prefix`** for internal/private members (e.g., `_client`, `_selector`)
- **Section dividers**: `// ─── Name ───` in major files
- **Type exports** use explicit `type` keyword
- **No barrel exports** — `index.ts` has explicit re-exports
- **Unused vars**: `_` prefix to suppress warnings (`argsIgnorePattern: '^_'`)
- **`@typescript-eslint/no-explicit-any`**: error — avoid `any`; use `unknown` with type narrowing, or targeted `eslint-disable` with a justification comment for genuinely untyped boundaries (e.g., dynamic proto loading)
- Tests live in `src/__tests__/*.test.ts` and use Vitest with mocks (no live device)

## Key SDK abstractions

- **Selectors** (`selectors.ts`): Immutable, built via `role()`, `text()`, `contentDesc()`, etc. Serialized to proto via `selectorToProto()`. Accessibility-first (prefer role/text over className/xpath).
- **ElementHandle** (`element-handle.ts`): Lazy-resolved locator. Supports `.first()`, `.last()`, `.nth()`, `.all()`, `.filter()`, `.and()`, `.or()`, `.element()` for scoping. AND binds tighter than OR.
- **Device** (`device.ts`): Main user-facing API wrapping gRPC client. Default timeout 30s.
- **Assertions** (`expect.ts`): Locator assertions (auto-waiting, 250ms poll) + generic value assertions. Supports `.not`, `expect.soft()`, `expect.poll()`.
- **Runner** (`runner.ts`): Custom test runner with `test()`, `describe()`, `.only`, `.skip`, hooks, screenshot-on-failure.
- **gRPC client** (`grpc-client.ts`): Dynamic proto loading via `@grpc/proto-loader` (no codegen step on TS side).

## Design principles

- **Playwright is the bar.** The goal is to match Playwright's robustness, reliability, and developer experience for mobile. Don't cut corners -- handle edge cases, add proper error messages, implement auto-waiting correctly, and write thorough tests.
- **Don't reinvent the wheel.** Use well-maintained open source packages rather than writing custom implementations. If a proven library exists for the job (parsing, diffing, formatting, etc.), prefer it over hand-rolling.

## Documentation

- **Keep `docs/api-reference.md` up to date** when adding or changing public API (new methods on Device, ElementHandle, new assertions, new types, etc.). This is the single source of truth for users.
- Other docs (`getting-started.md`, `selectors.md`, `configuration.md`, `ci-setup.md`) only need updates if the feature changes user-facing workflows.

## Commit style

Descriptive imperative messages. Feature work happens on branches (e.g., `feat/locator-api-enhancements`) with PRs to main.
