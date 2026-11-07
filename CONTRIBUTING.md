# Contributing

Thank you for helping. Gerda is a TypeScript kernel that runs inside a Minecraft client (jsMacros/GraalJS), plus host-side tooling. Most contributions need no running game: the domain layer and the capability loops are testable on a mock runtime.

## Dev setup

```sh
git clone https://github.com/flamerix-ai/gerda.git && cd gerda
bun install        # toolchain (tsup, biome, vitest)
just hooks         # git hooks — there is no CI; these ARE the gate
just check         # what pre-push runs: tsc + biome + defensive-code check + vitest + python suites
```

Pre-commit runs the TS half (`just check-ts`); pre-push runs all of `just check`. Installing
bun, just and python from zero: [docs/SETUP.md](docs/SETUP.md) steps 1–2.

`flake.nix` provides the full dev shell (bun, node, python, just) via `direnv`/`nix develop`, but plain **bun ≥1.1 + python ≥3.11 + ffmpeg** (with its ffprobe) is enough for everything except the optional extras (decompiler, capture shell). `just check` needs ffmpeg: the python suites run real clips through it.

To actually run the bot in a game, follow [docs/SETUP.md](docs/SETUP.md).

## The gate

There is no CI service: CI runners cannot boot Minecraft. The gates are local and mandatory: the
pre-commit and pre-push git hooks.

`just hooks` wires them (sets `core.hooksPath`). Do not skip them with `--no-verify`: when a
hook fails, fix the cause — its last lines name the failing stage; rerun that stage by hand. A PR that fails `just check` goes back to its author. What each hook runs, the test counts and what each layer covers: [docs/TESTING.md](docs/TESTING.md).

## The three test layers

1. **Unit / property tests** (`test-ts/`, vitest) — pure domain logic and capability loops against the in-memory mock runtime. This is where most coverage lives; new logic should land with tests here. `bun run test`, single file: `node_modules/.bin/vitest run test-ts/vein.test.ts`.
2. **Facade smoke** — live sanity of the `Runtime` facade against a real game (`diagnostics.smoke` over the bridge). Run when you touch `src/core/runtime/`.
3. **Arena gate** (`just gate-live`) — declarative in-game scenarios (build an arena, run a mission, assert journal events) against a connected test bot. Manual by design; required before merging behaviour changes. See [docs/TESTING.md](docs/TESTING.md).

Python host tools have their own stdlib-only suites, wired as `just test-py` (and into the pre-push hook): `scripts/tests/` (host tooling — local config, the gerda dispatcher) and `scripts/objective/tests/` (the objective engine + FTB adapter).

## Conventions (reviews enforce these)

- **Tunables live in `src/shared/config/schema.ts`.** A magic number in capability or domain code is a bug. Timing is in ticks (20 = 1 s).
- **Everything game-facing goes through the `Runtime` facade** (`src/core/runtime/`). Domain code takes plain data and never imports the runtime. `src/core/runtime/jsmacros/` is the only code allowed to touch jsMacros globals; `core/runtime/mock.ts` implements the same interface so tests can't drift.
- **Fail loud.** Runtime reads return `Result` — no nulls, no silently-fabricated fallbacks. Use `must()` over index casts. Contract violations throw `ContractError`, which halts the mission instead of corrupting it. The defensive-code checker in `bun run check` rejects speculative `try/catch`-and-continue.
- **No dead code.** Delete unused branches and compatibility shims; git keeps the history.
- **Adding a capability** = one module in `src/bot/capabilities/` + one `register` line in `src/bot/entry/worker-bundle.ts`. No kernel edits. Declare FSM edges in the capability, not by hand in `src/bot/profile/states.ts`.
- Biome enforces style (`noExplicitAny`, `noNonNullAssertion`, throw-only-Error are **errors**); `bun run format` before committing saves a round-trip.

## Where code goes

The repo layout, with where each kind of new code belongs, is in [docs/index.md](docs/index.md#repo-layout-and-where-new-code-goes).

Start from [`examples/`](examples/README.md) — each file is a runnable template for one of these layers. The deep dive on extending (missions, plans, SRG mapping, the Runtime contract) is [docs/EXTENDING.md](docs/EXTENDING.md). Writing a bot of your own on the harness instead of extending Gerda Bot? [docs/BUILD_YOUR_OWN_BOT.md](docs/BUILD_YOUR_OWN_BOT.md) maps how little you must adopt.

## Keeping docs true (what to update when you change X)

Docs stay true in three ways: **gated** (a test fails the commit if code and doc
diverge), **self-describing** (the code or live manifest is the doc), and
**hand-written** (this table tells you what to touch). When your change matches a
row, update the doc in the same PR:

| You changed… | Update… | Drift protection |
|---|---|---|
| A mission's `name`/`params`, added/removed a mission | `docs/MISSIONS.md` | **Gated** — `test-ts/docs-drift.test.ts` fails the commit if a registered mission or param isn't mentioned |
| Added/moved a script under `scripts/` | the `gerda` table + `scripts/README.md` | **Gated** — `scripts/tests/test_gerda.py` fails on a dangling CLI entry |
| A tunable in `src/shared/config/schema.ts` | nothing | **Self-describing** — the schema + its comments are the SSOT; never duplicate values into docs |
| A bridge command (main.js `HANDLERS`/`META_COMMANDS`, ext.js `register`, a worker command + its `WORKER_COMMAND_DOCS` row) | its `META_COMMANDS`/`meta`/`WORKER_COMMAND_DOCS` help entry, then `just commands-ref` | **Gated** — `test-ts/commands-ref.test.ts` fails the commit when `docs/COMMANDS.md` differs from a render of those rows, a row has no description, or a dispatched name has no row; `mc://api` serves the same set live |
| An always-on capability, a plan, or a reflex | `docs/EXTENDING.md` (capability table) / `docs/MISSIONS.md` / `docs/SAFETY.md` | **Gated** — `test-ts/docs-drift.test.ts` fails the commit if a registered name is not named there as code |
| GlobalVars IPC keys (`harness/ipc.js`) | `docs/IPC.md` | Hand-written (ipc.js is cited there as SSOT) |
| A reflex / safety behaviour | `docs/SAFETY.md` | Hand-written; the reflex NAME is gated (row above) |
| Kernel/mission/capability contracts | `docs/EXTENDING.md` (+ `examples/` if a template is affected) | Hand-written; examples are **gated** (they typecheck in `bun run check`) |
| Setup steps, prerequisites, launcher handling | `docs/SETUP.md` family, `README.md` quickstart | Partially gated — `just smoke-clean` proves the host-side path on a clean distro |
| Modpack/version assumptions | `docs/PORTABILITY.md` | Hand-written |

When you add a NEW checkable relationship (declarative data that a doc restates),
extend `docs-drift.test.ts` — presence checks are cheap and catch silent drift.

## PRs

- Small and focused beats big and mixed.
- Behaviour changes: unit tests required, arena/`gate-live` run noted in the PR description if applicable.
- If you changed anything under `harness/` or the bridge protocol, say how you live-tested it (which command, which bot).
- Docs count as contributions, and setup friction reports help most. Running on a
  different pack or MC version? [docs/PORTABILITY.md](docs/PORTABILITY.md) maps
  what is involved; pack profiles and version ports are welcome.
- Not sure where to start? Ask in [GitHub Discussions](https://github.com/flamerix-ai/gerda/discussions).
