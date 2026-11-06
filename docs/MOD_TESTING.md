# Test your mod in a real game

You write a Minecraft mod or maintain a modpack, and you want to check its behaviour in a
running game: a block drops only for the right tool, a recipe exists, a machine reacts. Unit
tests do not start Minecraft, and checking by hand does not repeat. This page shows how to run
such checks with the Gerda harness, headless, in a container, from a few commands.

What you get:

- A **real Minecraft client** with your mod, in a rootless podman container. It needs no GPU and
  no screen: the game renders in software on a virtual display.
- A **bridge** into the running client. Through it you read the world, the player and the
  screens, send chat and commands, take screenshots, and run JavaScript with full Java access
  (`jeval`), so you can call your mod's own classes.
- **Arenas**: test files that build a small scene and then assert game state. An assertion
  that does not hold fails the run with the value it got.
- A **video** of the run, recorded off the virtual display and checked to be not black.

The worked example below tests a feature of GregTech CEu, the mod at the center of the
Monifactory pack: tungstate ore drops only for an iron pickaxe or better.

## 1. Get the repo and the sandbox

You need Linux with rootless podman and internet access. Clone the repo:

```sh
git clone https://github.com/flamerix-ai/gerda
cd gerda
```

The sandbox lives in `scripts/sandbox/`. Its README has the requirements (RAM, disk, CPU), every
step, the measured times and why each part is built the way it is:
[scripts/sandbox/README.md](https://github.com/flamerix-ai/gerda/blob/main/scripts/sandbox/README.md).
Build the image and start the container:

```sh
scripts/sandbox/provision.sh build      # the image (Ubuntu 24.04, Java 21, Xvfb, Mesa, ffmpeg)
scripts/sandbox/provision.sh up         # the container
```

The `repo` step clones the harness into the container. Its place in the order matters: `matrix`
and `pack` need it to run first, and the Monifactory client gets the harness only from a `repo`
that runs after `client`. Sections 2 and 4 show the order.

`provision.sh shell` opens a shell in the container. After `repo`, the clone is `~/gerda`
there. In this page, `provision.sh …` lines run on your machine, and every other command runs
in that shell, in `~/gerda`.

## 2. Put your mod into a game

Pick one of two paths.

### Path A: your mod in a vanilla + loader instance

`matrix` builds four instances (vanilla + loader + jsMacros), each with a single-player world
called `New World`, generated in peaceful mode with cheats allowed (the arena commands need them):

```sh
scripts/sandbox/provision.sh repo https://github.com/flamerix-ai/gerda   # the harness, inside
scripts/sandbox/provision.sh matrix
scripts/sandbox/provision.sh add-mods Fabric-1.20.1 path/to/yourmod.jar
scripts/sandbox/provision.sh start-matrix Fabric-1.20.1           # opens New World, waits for the bridge
```

| Instance | Loader | Bridge port |
|---|---|---|
| `Fabric-1.20.1` | Fabric loader + Fabric API | 55560 |
| `Fabric-1.21` | Fabric loader + Fabric API | 55561 |
| `Forge-1.18.2` | Forge 40.3.0 | 55562 |
| `Vanilla-Forge-1.20.1` | Forge 47.4.13 | 55563 |

`matrix` prints the ports, and `~/matrix/mc-bots.json` keeps them. Check that the game loaded your
mod:

```sh
P=55560
./gerda ctl --port $P ping
./gerda ctl --port $P send jeval '{"code":"Java.type(\"net.fabricmc.loader.api.FabricLoader\").getInstance().isModLoaded(\"yourmodid\")"}'
```

On Forge, ask `Java.type("net.minecraftforge.fml.ModList").get().isLoaded("yourmodid")` instead.

### Path B: your modpack

`pack` builds a test instance from a CurseForge-format modpack zip (`manifest.json` +
`overrides/`). It gives the zip to the launcher's own import, as a player does: the launcher
downloads the mods with its own CurseForge access. Then `pack` adds jsMacros when a pinned
build matches and generates a world:

```sh
scripts/sandbox/provision.sh repo https://github.com/flamerix-ai/gerda   # skip if done for path A
scripts/sandbox/provision.sh pack MyPack path/to/MyPack.zip
scripts/sandbox/provision.sh start-matrix MyPack
```

A zip given by URL needs its sha256 as the third argument, or `--unpinned` to take it
unchecked (then it is downloaded again on every run). The step writes the folder, name and sha256
of each installed mod file to `~/.sbx/pack-MyPack-files.tsv`. Nothing pins these files.

If the import cannot finish by itself, install the pack once in your own launcher. Then give
the step that instance's folder with `--from`. The step takes the mod files from that folder:

```sh
scripts/sandbox/provision.sh pack MyPack path/to/MyPack.zip --from ~/.local/share/PrismLauncher/instances/MyPack
```

The import cannot finish by itself when a mod author keeps a file out of third-party
launchers and no copy of the file is on Modrinth. The step then fails and names each blocked
file with its CurseForge page. Section 7 tells more.

The reference pack is set up by its own steps, with a dedicated server: `server`, `client`,
`repo` and `start` install and run Monifactory 0.13.4 with the bot account joined on bridge
port 55544. The worked example in section 4 runs there.

## 3. Write a test: an arena

An arena is a JSON file in `scenarios/arenas/`. Its file name is its name. `ops` build the scene
with operator commands, then each entry of `checks` runs one `jeval` and compares the JSON value
it returns with `expect`:

```json
{
  "desc": "my block needs a diamond pickaxe",
  "ops": [
    { "op": "clear", "from": [-2, 101, -2], "to": [2, 104, 3] },
    { "op": "fill",  "from": [-2, 100, -2], "to": [2, 100, 3], "block": "minecraft:stone" },
    { "op": "set",   "pos": [0, 101, 2], "block": "mymod:my_block" },
    { "op": "clearinv" },
    { "op": "give",  "item": "minecraft:diamond_pickaxe" },
    { "op": "player", "pos": [0, 101, 0] },
    { "op": "wait",  "ticks": 40 }
  ],
  "checks": [
    {
      "desc": "the block is there",
      "jeval": "World.getBlock(0, 101, 2).getId()",
      "expect": "mymod:my_block"
    },
    {
      "desc": "it drops only for the correct tool",
      "jeval": "World.getBlock(0, 101, 2).getBlockStateHelper().isToolRequired()",
      "expect": true
    }
  ]
}
```

- `ops` (all of them: `scripts/dev/arena.py`, top of the file): `clear` and `fill` a box, `set`
  one block, `clearinv`, `give` an item, `select` a hotbar slot, `player` teleports the client,
  `wait` sleeps a number of ticks. The `wait` at the end gives the server time to sync the
  blocks and items back to the client before the checks read them.
- `jeval` code is JavaScript with the full jsMacros and Java scope: `World`, `Player`,
  `Client`, `Java.type(...)` for any class, your mod's included. The value of the last
  expression is the result. `expect` is compared as canonical JSON, so `true` is not `1`.
- Every check runs, also after one fails. The arena passes only when all of them pass.
- An arena can also run a bot mission and assert its log events (`mission` + `expect.events`);
  that is how the Gerda bot's own behaviour is tested ([TESTING.md](TESTING.md)).

### Make the test able to fail: a known-bad twin

A check that cannot fail proves nothing. Pair each arena with a **known-bad** twin: the same
file with a `known_bad` key that says what it wrongly claims, and `"wrong": true` on each check
whose `expect` is wrong on purpose. Each marked check needs exactly one unmarked check in the
same file with the same `jeval` and the right value as its `expect`; the arena does not load
without it. A marked check passes only when its own answer is exactly that right value and the
unmarked check passed too: the game refused the wrong claim by giving the right answer. The
other checks keep their correct values and must pass as usual.

So the known-bad fails when the game accepts the wrong value, because then the check cannot
tell right from wrong. It also fails on any other answer: a jeval error, a null, a third value
(for example, the pickaxe was never given), or when a scene check fails (the block was not
placed). A broken setup never counts as a pass.

## 4. Worked example: GregTech CEu ore needs the right pickaxe

[`gtceu-ore-harvest-tier.json`](https://github.com/flamerix-ai/gerda/blob/main/scenarios/arenas/gtceu-ore-harvest-tier.json)
places `gtceu:tungstate_ore`, gives the player a stone pickaxe (hotbar slot 0) and an iron
pickaxe (slot 1), and asks the game's own harvest predicate with each one in hand.
`Player.hasCorrectToolForDrops` is the method Forge calls when a block breaks, to decide if
it drops anything. The check selects the slot and returns both the held item and the answer:

```js
(function () {
  Player.openInventory().setSelectedHotbarSlotIndex(0);   // the stone pickaxe
  var p = Player.getPlayer();
  var state = World.getBlock(0, 101, 2).getBlockStateHelper().getRaw();
  return { held: p.getMainHand().getItemId(),
           drops: p.getRaw()[srg('Player', 'hasCorrectToolForDrops')](state) };
})()
```

`getRaw()` gives the Minecraft object. On Forge its methods have SRG names (`m_36298_`);
`srg(class, member)` looks the name up for you ([EXTENDING.md](EXTENDING.md) § SRG-mapping
workflow). Its twin,
[`gtceu-ore-harvest-tier-knownbad.json`](https://github.com/flamerix-ai/gerda/blob/main/scenarios/arenas/gtceu-ore-harvest-tier-knownbad.json),
keeps the ore check and the stone-pickaxe check as they are, and adds the same stone-pickaxe
question once more, marked `"wrong": true`, claiming that the stone pickaxe gets the drop.

Run it in the Monifactory sandbox. The arena ops are operator commands, and the bot plays as a
normal non-op player, so give it operator rights from the server console for the test, and take
them back after:

```sh
scripts/sandbox/provision.sh server && scripts/sandbox/provision.sh client
scripts/sandbox/provision.sh repo https://github.com/flamerix-ai/gerda   # again if it ran before client
scripts/sandbox/provision.sh start && scripts/sandbox/provision.sh verify
scripts/sandbox/provision.sh console op student_bot
```

In the container shell:

```sh
just gate-live gtceu-ore-harvest-tier gtceu-ore-harvest-tier-knownbad
```

The output. The values are the ones a run in a fresh sandbox returned:

```text
── gtceu-ore-harvest-tier ──
  8 ops applied
  [PASS] the placed block is GTCEu tungstate ore: "gtceu:tungstate_ore"
  [PASS] it drops only for the correct tool: true
  [PASS] a stone pickaxe in hand gets no drop: {"held": "minecraft:stone_pickaxe", "drops": false}
  [PASS] an iron pickaxe in hand gets the drop: {"held": "minecraft:iron_pickaxe", "drops": true}
  [PASS] checks
── gtceu-ore-harvest-tier-knownbad ──
  8 ops applied
  [PASS] the placed block is GTCEu tungstate ore: "gtceu:tungstate_ore"
  [PASS] a stone pickaxe in hand gets no drop: {"held": "minecraft:stone_pickaxe", "drops": false}
  [PASS] WRONG ON PURPOSE: a stone pickaxe in hand gets the drop: refused the wrong {"held": "minecraft:stone_pickaxe", "drops": true} — got the right {"held": "minecraft:stone_pickaxe", "drops": false}
  [PASS] checks
=== gate summary ===
  PASS  gtceu-ore-harvest-tier
  PASS  gtceu-ore-harvest-tier-knownbad
[gate] 2/2 passed
```

A failing check prints `got …, expected …`, and the command exits `1`. Exit `2` means there was
no verdict: no client answered on the bridge. After the test:

```sh
scripts/sandbox/provision.sh console deop student_bot
```

`just gate-live` with no names runs every arena in `scenarios/arenas/`, including the bot's
own. Name yours to run only them.

**On a test-root instance (path A or B)** the player is the world's owner, so it needs no `op`.
Run an arena against its port with the arena tool:

```sh
python3 scripts/dev/arena.py run my-block-check --port 55560
python3 scripts/dev/arena.py clean my-block-check --port 55560   # the scene back to air
```

`arena.py run` exits `0` on a pass and `1` on a fail, like the gate; it does not clean up.

## 5. Screenshots and video

Screenshots come from the game itself:

```sh
./gerda ctl send screenshot     # writes <instance>/minecraft/screenshots/ai_shot.png
```

`provision.sh fetch <path>` copies a file out of the container. A path without a leading `/` is
relative to the container user's home.

To record a video, run `record` while the test runs, for example from a second terminal:

```sh
scripts/sandbox/provision.sh record 60 gtceu-run.mp4
```

`record` films the window of the running client with ffmpeg (`x11grab` on the virtual display,
h264, 30 fps) and measures the file with `scripts/rig/motion_probe.py`: the mean brightness
(luma) of the sampled frames, and how much the picture moves. A recording whose mean luma is
under 30 of 255 fails as black. A good one is copied to your machine. Add `--detach` to
record in the background; `provision.sh wait record` then waits for it, and `provision.sh fetch
recordings/<name>.mp4` copies it out.

The video runs at the speed of the game. Software rendering gives about 20-30 fps.

## 6. Drive it from an LLM

The MCP server (`mcp/server.py`) gives an LLM client the same bridge as tools: `mc_ping`,
`mc_get_state`, `mc_send` (any bridge command, `jeval` too) and the fleet tools. `mc://api`
lists every command. The server runs inside the container and talks MCP over stdio, so a client
on your machine can start it through `podman exec`:

```json
{
  "mcpServers": {
    "mc": {
      "command": "podman",
      "args": ["exec", "-i", "-u", "student", "-w", "/home/student/gerda", "gerda-sandbox",
               "uv", "run", "mcp/server.py"]
    }
  }
}
```

Set `MC_BRIDGE_PORT` (for example with `"env"` in that entry, or `podman exec -e`) to talk to a
test-root instance instead of 55544. From Python scripts, `mcp/bridge_client.py` is the client:
`BridgeClient(host="127.0.0.1", port=P).send("jeval", {"code": "..."})`.

## 7. Limits

- **Speed.** Software rendering is slow: the modded client takes several minutes to load, and
  right after a join the bridge answers late for a minute. Retry the first command. A check
  that depends on timing can fail on a busy machine.
- **Offline accounts.** The sandbox plays with offline accounts (`online-mode=false`). There is
  no Microsoft login, so no Realms and no online-mode servers.
- **Forge vs Fabric.** The harness (bridge, screenshots, `jeval`, arenas, MCP) works on every
  Minecraft version that has a jsMacros build. `srg()` and the SRG names are Forge-only: on
  Fabric, raw Minecraft methods have intermediary names (`method_…`), so prefer the jsMacros
  helpers there. The Gerda **bot** moves only on Forge. See [PORTABILITY.md](PORTABILITY.md).
- **jsMacros sets the version range.** No jsMacros build for your Minecraft version means no
  harness. Which versions have one: [PORTABILITY.md](PORTABILITY.md).
- **CurseForge downloads.** The sandbox does not download from CurseForge itself. `pack` and
  the Monifactory `client` step give the modpack zip to the launcher's own import
  (FreesmLauncher, a Prism Launcher fork). The launcher gets the files through its own access
  to the official CurseForge API, so it keeps the choice of each mod author:
  - A file that its author keeps out of third-party launchers comes from the author's own
    Modrinth upload, when there is one. In Monifactory 0.13.4, one file comes this way
    (`entityculling`), and it is the same file, byte for byte.
  - Otherwise the launcher asks for a manual download. The sandbox does not wait for a click.
    The step fails and prints each blocked file with its CurseForge page.

  The fallback for either step is `--from <folder>`: install the pack once in your own
  launcher (blocked files downloaded by hand), then point the step at that instance's folder.
  The step copies the mod files from there. For Monifactory, the step checks every file
  against the sha256 pins (`monifactory-0.13.4-client-files.tsv`), the same check as after
  the import. A missing or changed file fails. For a pack of your own, the step records the
  files and their sha256, and nothing pins them.
- **Client-side view.** `jeval` runs in the client. It reads the client's copy of the world,
  which the server keeps in sync, and calls game logic on the client side. Logic that only the
  server runs (a machine's recipe processing, world generation) is not directly reachable from
  a multiplayer client; in a single-player world the integrated server is in the same process.
- **Not tested here:** NeoForge and Quilt instances, more than one test-root client at a time,
  and hosts other than Linux with rootless podman.
