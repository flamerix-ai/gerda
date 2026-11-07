# How Gerda was built

*Gerda — open-source bot framework by Flamerix AI.*

Gerda is a framework for writing and running bot code inside Minecraft on the jsMacros mod.
Gerda Bot is the reference implementation on it: an autonomous ore-mining bot, and a small co-op
fleet, for the GregTech CEu modpack Monifactory on Minecraft 1.20.1. It prospects veins, walks to
them with its own navigator, digs them out, hauls the ore home, smelts, crafts a spare pickaxe so
a worn one can be swapped out and goes back out. The bots join a co-op server as ordinary non-op
players. Nobody hands them items in fleet play: they earn what they use.

This page is about what we found while building it and how we solved it.

## No LLM in the runtime loop

The bot is ordinary deterministic code: a TypeScript kernel, compiled to one bundle that the
[jsMacros](https://jsmacros.wagyourtail.xyz/) mod runs inside the game client, 20 ticks a
second. At runtime nothing calls a model. The API cost is zero, there is no latency spike while
a prompt runs, and the same world state gives the same decision.

An LLM *can* drive it. The repo ships a standard MCP server (`mcp/server.py`) that exposes live
bots as tools: `mc_get_state`, `mc_send`, and fleet calls such as "a free bot, go get iron".
Nothing in the bot depends on it: with no MCP client attached, the bots keep playing.

How this differs from well-known neighbours:

- **[Voyager](https://voyager.minedojo.org/)** is a research system in which an LLM writes and
  refines its own skill code as it plays. The LLM is the learner.
- **[Mindcraft](https://github.com/kolbytn/mindcraft)** puts an LLM in charge of an in-game
  agent you can talk to. Great for conversation and open-ended play; every decision is a model
  call.
- **[Baritone](https://github.com/cabaletta/baritone)** is an excellent pathfinding utility.
  We learned a lot from its movement model before writing our own navigator.

Gerda Bot takes a third route: plain code that plays on its own, with an LLM as an optional
driver rather than a dependency.

## By the numbers

- `src/` is **156 TypeScript files, ~24k lines**, plus ~16k lines of tests.
- The tests: vitest suites for the kernel and Python suites for the host tooling.
  [TESTING.md](TESTING.md) has the current count.

## What we found, and what we built

### One seam to the game, with a mock that cannot drift

Only one layer, the runtime facade, may touch jsMacros. It is a TypeScript interface with two
implementations: the real one and an in-memory mock. Because both implement the same interface,
the mock cannot drift: add a method to the real runtime and the mock stops compiling. This is
why the whole test suite runs in seconds without Minecraft.

### Our own navigator

A mining bot keeps changing the world under its own path, and Baritone's standalone build
exposes no Java API to scripts — only chat commands and position polling. So Gerda Bot has its
own navigator: A* over a cached world view (D* Lite optional, off by default), and a greedy
executor with sub-machines for ladders, pillaring, bridging and sprint-jump parkour. Hazard
vetoes keep it out of lava, water traps and pits it cannot climb back from.

We measured before switching. `navbench` races navigators on identical legs in the live game:
ours arrives on every leg, like Baritone, and is within 13 % on speed; the slower legs come from
deliberate safety margins. Ideas from Baritone (movement physics, goal types, block traits)
live on as data. See [navbench.md](navbench.md).

### Forge member names are SRG — resolved offline

On Forge 1.20.1, class names are readable but class *members* keep obfuscated SRG names
(`m_7583_`, `f_91073_`). GraalJS resolves members by their real name, so `mc.level` by its
readable name is simply `undefined`. Our answers:

- **Ask the jsMacros facade, not raw fields.** `Player.getPlayer() != null` tells you the client
  is in a world; a raw-field probe cannot.
- **Look names up offline.** `srg.py` resolves Mojang ↔ SRG names from the mapping files the
  launcher already has on disk, with Parchment parameter names when available. No trial calls in
  game.
- **Call by Mojang name.** `srg('Player','getFoodData')` resolves the SRG name at runtime, and a
  boot self-check verifies every hardcoded token against the current pack's map.
- **Read the source.** `decompile.sh` decompiles the game or any mod jar to Mojang-named source.

### Guarding the render thread

A command that blocks the render thread for more than 500 ms makes jsMacros kill the handler,
and a long block can drop the world. Three guards keep the game responsive: the `jeval` escape
hatch rejects blocking code before it runs, the bridge restarts a stalled supervisor, and a lint
rule stops committed harness code from blocking the render thread.

### GraalJS threading and number coercion

GraalJS binds each JS context to one thread, so timed sequences are driven from the host over
separate bridge calls, never by closures handed between threads. A JS number passed to a Java
`float` parameter must be exactly representable as a float, so the facade wraps such values in
`Math.fround()`.

### Verify effects, not attempts

The water-bucket clutch places water under the bot mid-fall to survive long drops. It aims and
retries every tick while the drop point is in reach, leads the aim by the horizontal drift, and
counts the clutch as done only when the bucket is actually empty. The same rule runs through the
kernel: eating is confirmed by the food level, a teleport by the position change, a deposit by
re-reading the bag.

### A camera that moves every frame

Setting the player's rotation once per tick looks jerky on film. The camera client instead hooks
Forge's per-frame `ViewportEvent.ComputeCameraAngles`, registered from GraalJS through the
explicit-class `addListener` overload, so camera moves are smooth at any frame rate.

### Off-screen capture

The rig runs each client inside its own **headless sway** compositor with a 60 Hz output and
records it with `wf-recorder`. Nothing appears on the monitor.

## The film rig is a feature

We shot our teaser with the same harness ([RIG.md](RIG.md)). Bot and camera clients boot inside
headless compositors. Scenes are staged from data and re-armed between laps, and a scripted
camera flies smooth moves; inside a lap, the bot's moves are its own. The clutch shot starts
with a scripted step off the ledge, and catching that fall is the bot's reflex. Takes are
accepted by measurement: a motion probe rejects frozen or dead footage. The cut is assembled
from a JSON cut list with burned-in captions.

On set, too, the bots play as real players: they are non-op on our co-op server, and the camera
client is the only op. The scenes around them are staged, from the sets to the items the camera
drops to the bot; [RIG.md](RIG.md#what-the-filmed-scenes-stage) lists what is staged and how.

## How we work

We build it with Claude Code; the process is built to catch mistakes before they land:

- **The git hooks are the gate.** In-game tests cannot run in CI, and pure checks belong at
  commit time. `pre-commit` runs `tsc`, `biome`, a defensive-code checker and `vitest`;
  `pre-push` repeats them, adds the Python suites, and builds and validates the bundle.
- **Fail loudly.** The defensive-code checker rejects `try/catch`, `as` casts, empty `catch`
  blocks and dropped `Result`s outside a few boundary files. Fallible game reads return a typed
  `Result`, never a made-up default. A core bug halts the worker; a mission bug drops only that
  mission to ERROR. A silent `0` would hide the bug from whoever reads the log next.
- **One trunk, one worktree per task.** Everything lands on one trunk by fast-forward. Each
  task, human or agent, runs in its own git worktree, so parallel work doesn't collide.
- **Independent review.** For changes that matter, a separate review agent, which never saw the
  author's reasoning, tries to break the diff before it lands.
- **Every test has a known-bad twin.** Each positive test is paired with an input that must
  fail. A gate never seen rejecting anything proves nothing.
- **Write it down.** `CLAUDE.md` and `docs/EXTENDING.md` are the onboarding that every
  contributor, human or agent, reads first. When an approach is dropped, the reason and the
  evidence are written down at once, so nobody retries it blind.

## What carries over to your project

1. **Measure the runtime before designing for it.**
2. **One typed seam to the outside world, with a mock that cannot drift.**
3. **Make the gate local and hard to skip.**
4. **Fail loudly.** Silent fallbacks turn into false beliefs later.
5. **Verify effects, not attempts.**
6. **Write down why an approach was dropped, when you drop it.**

## Scope

Gerda Bot and the bundled mod plugins are tuned to Monifactory and GregTech CEu: ore registry,
prospector and quests. The [portability guide](PORTABILITY.md) maps what carries over to other
packs and versions. Movement physics and real block breaking have no mock, so in-game behaviour is
checked by a manual live gate (`just gate-live`). Run the bots only on servers that allow
automation.

## Help us make it better

We are Flamerix AI, a software company, and we are asking for your advice. What is unclear or
inconvenient? What looks wrong? How can we make Gerda clearer and easier for players, server
admins and modders?

- Code (MPL-2.0): [github.com/flamerix-ai/gerda](https://github.com/flamerix-ai/gerda)
- Questions and ideas: [GitHub Discussions](https://github.com/flamerix-ai/gerda/discussions)
- Bugs and requests: [GitHub Issues](https://github.com/flamerix-ai/gerda/issues)
- Contact: [hello@flamerix.ai](mailto:hello@flamerix.ai)

Made with the help of DRIM by [Flamerix AI](https://flamerix.ai).
