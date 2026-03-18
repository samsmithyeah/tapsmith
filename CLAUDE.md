# Pilot

Mobile app testing framework with a Playwright-inspired API. Three-tier architecture:
**TypeScript SDK** (test runner + assertions) → **gRPC** → **Rust daemon** (pilot-core) → **ADB/socket** → **Kotlin on-device agent** (UIAutomator2).

## Project structure

```
packages/pilot/        # TypeScript SDK — selectors, element handles, assertions, runner, CLI
packages/pilot-core/   # Rust daemon — gRPC server, ADB bridge, device management
agent/                 # Android Kotlin agent — UIAutomator2 instrumentation
proto/pilot.proto      # gRPC contract (single proto file, buf for linting)
docs/                  # User-facing documentation
test-app/              # React Native (Expo) test app for E2E testing
e2e/                   # E2E test suite run against the test app
```

Each component has independent dependencies and build lifecycle (not a JS monorepo).

## Build & test commands

### TypeScript SDK (`packages/pilot/`)
```bash
npm ci                  # install deps
npm run typecheck       # tsc --noEmit
npm run lint            # eslint
npm run test            # vitest run (unit tests, no device needed)
npm run knip            # unused code detection
npm run build           # tsc → dist/
```

### Rust daemon (`packages/pilot-core/`)
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

### Proto (`proto/`)
```bash
buf lint proto/
buf breaking proto/ --against '.git#ref=origin/main,subdir=proto'
```

## CI

GitHub Actions runs 4 parallel jobs: `proto-lint`, `typescript`, `rust`, `android`. All must pass. See `.github/workflows/ci.yml`.

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

- **Playwright is the bar.** The goal is to match Playwright's robustness, reliability, and developer experience for mobile. Don't cut corners — handle edge cases, add proper error messages, implement auto-waiting correctly, and write thorough tests.
- **Don't reinvent the wheel.** Use well-maintained open source packages rather than writing custom implementations. If a proven library exists for the job (parsing, diffing, formatting, etc.), prefer it over hand-rolling.

## Documentation

- **Keep `docs/api-reference.md` up to date** when adding or changing public API (new methods on Device, ElementHandle, new assertions, new types, etc.). This is the single source of truth for users.
- Other docs (`getting-started.md`, `selectors.md`, `configuration.md`, `ci-setup.md`) only need updates if the feature changes user-facing workflows.

## Commit style

Descriptive imperative messages. Feature work happens on branches (e.g., `feat/locator-api-enhancements`) with PRs to main.
