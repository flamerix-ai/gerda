#!/usr/bin/env python3
"""Reproducible LIVE stager for the sustain-cycle cinematic demo.

Reproduces `scenarios/arenas/sustain-cycle.json` on the DEDICATED SERVER (where the
bot is NON-OP) and starts the infinite mine->smelt->restock loop, so the whole scene
+ run is one repeatable command. Everything the arena harness would do via the bot's
(op) bridge is instead issued from the SERVER CONSOLE (full authority, no opping a bot).

  python3 scripts/demo/sustain_live.py build     # stage the scene (console block ops)
  python3 scripts/demo/sustain_live.py supply     # honest drop->pickup of the starter kit
  python3 scripts/demo/sustain_live.py storage    # place + register the deposit chest
  python3 scripts/demo/sustain_live.py wait        # block until the camera is IN-WORLD (hook gate)
  python3 scripts/demo/sustain_live.py frame       # park bot at spawn + camera pose + HUD off
  python3 scripts/demo/sustain_live.py hud         # hide the HUD on the operator camera only
  python3 scripts/demo/sustain_live.py run         # plan_start sustain-cycle
  python3 scripts/demo/sustain_live.py all         # build->supply->storage->frame->run
  python3 scripts/demo/sustain_live.py loop [N]    # N host-paced clean laps (default forever)
  python3 scripts/demo/sustain_live.py stop        # plan_abort

WHY A HOST-PACED `loop` (the reproducibility payoff)
  The 8-step plan runs ONE autonomous lap flawlessly (mine->goto->smelt-collect->
  smelt-LOAD->craft->store->prospect) but does NOT self-sustain many fast laps in this
  sealed sandbox: (1) the furnace input slot caps at 64 and the smelt-LOAD mission
  ERRORs if it cannot load its ENTIRE raw_iron stack, so a backlog >64 or a furnace
  left full from the previous lap blocks lap N+1; (2) once the local ore is mined out
  the plan walks off to the nearest PROSPECTED vein, which in the live world is
  hundreds of blocks away (and killed the bot mid-take). `loop` is the fix: each lap it
  aborts, resets the furnaces EMPTY (abort FIRST so the plan can't re-load mid-reset),
  refills the ore patch, teleports the bot back to base, and restarts the plan. Every
  lap the PLAN still autonomously does the real mine->smelt work on camera; the host
  just re-arms the sandbox between laps. See `seal()` for the pit/wander guards.

REPRODUCIBILITY / RELOCATABILITY CAVEAT
  The `sustain-cycle` plan targets the furnace bank by an ABSOLUTE config coord
  (cfg.sustain.basePos = {5,101,1}, compiled into the bundle via src/bot/profile/pack.ts).
  So the scene is reproducible but PINNED to these coords. To film "somewhere else"
  you must change pack.ts basePos + rebuild/redeploy the bot, then set ANCHOR below.
  With ANCHOR=(0,0,0) the coords equal the arena fixture's (canonical repro spot).

HONEST ECONOMY (fleet invariant): bots are never /give'n items. The starter kit
  (coal/cobble/table) is dropped by the op camera player (local.config.json
  `cameraAccountName`) ONTO the bot, which
  auto-picks-it-up — the same honest path the bot uses for its pickaxe. The bot then
  EARNS iron by mining, which is the product story.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "mcp"))
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(REPO / "scripts" / "rig"))
import local_config  # noqa: E402
import sway_windows  # noqa: E402  — the camera-port SSOT (stdlib-only, side-effect free)

from bridge_client import BridgeClient  # noqa: E402

ARENA = REPO / "scenarios/arenas/sustain-cycle.json"

BOT = "bot_1"          # the worker
BOT_PORT = 55545       # worker bridge
CAM_PORT = sway_windows.cam_port()   # operator bridge — SHOOT_CAM_PORT, as for shoot.py

# The worker instance's jsMacros dir — home of BOTH the world cache (prospected veins, cleared
# below so the plan's `prospect` step no-ops instead of walking the bot to a distant vein) and the
# NDJSON journal the plan witness reads. The instances root comes from scripts/local_config.py,
# the SSOT for machine paths (env MC_INSTANCES_ROOT > local.config.json > launcher autodetect) —
# a hardcoded ~/.local/share/FreesmLauncher/... would be a second home for that fact, and since
# the witness now reads the journal every lap, a stale root would silently cost a whole shoot's
# evidence. LAZY: local_config exits loudly when no launcher exists at all, and merely IMPORTING
# this module (the unit tests do) must never do that.
INSTANCE = f"Monifactory_{BOT}"   # instance folder <-> bridge name: bot_1 -> Monifactory_bot_1
JOURNAL_TAIL_BYTES = 64 * 1024    # how far back to look when there is no usable mark
_JOURNAL_ENV = os.environ.get("MC_WORKER_JOURNAL")


def worker_macros() -> Path | None:
    """`<instances>/<INSTANCE>/minecraft/config/jsMacros/Macros`, or None if unresolvable."""
    try:
        return local_config.instances_root() / INSTANCE / "minecraft" / "config/jsMacros/Macros"
    except SystemExit as e:
        # local_config is written to die on the CLI path. Here the caller is a per-lap probe, so
        # its message is printed and the caller degrades — an observability read must not be able
        # to end the shoot.
        print(f"[paths] instances root unresolved: {e}")
        return None


def worker_world_json() -> Path | None:
    macros = worker_macros()
    return macros / "mc_world.json" if macros else None


def worker_journal() -> Path | None:
    """The worker's NDJSON journal, read STRAIGHT OFF DISK — see journal_since() for why not
    through the bridge. `MC_WORKER_JOURNAL` overrides it (a differently-named instance, or a
    journal that lives under a non-default macroFolder)."""
    if _JOURNAL_ENV:
        return Path(_JOURNAL_ENV)
    macros = worker_macros()
    return macros / "miner.ndjson" if macros else None


# Build origin. Keep (0,0,0) so coords match the compiled plan's basePos (5,101,1).
ANCHOR = (0, 0, 0)

# Starter kit the plan needs but does NOT self-supply (fuel/filler/table).
# Pickaxe is assumed already held by the bot (dropped by the op camera before filming,
# docs/RIG.md § What the filmed scenes stage). Ids + counts mirror the arena.
KIT = [
    ("minecraft:coal", 32),          # furnace fuel — consumed every smelt lap
    ("minecraft:cobblestone", 32),   # nav filler (FILLER_LOW fail-fast otherwise)
    ("minecraft:crafting_table", 1), # the tool craft step's 3x3 grid
]

# Deposit chest for the plan's `store` step (the arena fixture omits it; we add one so
# the step is productive on camera). Coord + facing mirror sustain-loop.json's chest.
CHEST = (7, 101, 1)
CHEST_FACING = "west"

# The three furnaces + the ore patch, mirrored from the arena fixture. The bot loads
# basePos = FURNACES[1] (5,101,1); the outer two are set-dressing we keep lit (glow).
FURNACES = [(5, 101, 0), (5, 101, 1), (5, 101, 2)]
# 25-block iron_ore patch, y=101 (was 9). The plan self-loops and eats
# 3 ore per cycle at ~5 s/cycle, so 9 blocks lasted ~15 s of an 80 s take; the mine mission
# then sat in SCAN for ~114 s (r=32 spiral x 3 cycles at 50 blocks/tick) before
# SCAN_EXHAUSTED — the frozen tail of BOTH 05_economy takes (journal ticks 12914..13423,
# 13763..16046). 25 blocks outlast a 30 s lap (~6 cycles = 18 ore) with margin.
ORE_REGION = ((-2, 101, -5), (2, 101, -1))

# Two seals that make the sealed stage safe for an UNATTENDED loop:
#   BEDROCK floor  — the bot physically cannot dig a pit and strand itself below.
#   BARRIER ring   — an invisible wall so it cannot wander off the stage and die.
# Both are keyed off FOUNDATION_FOOTPRINT so they follow ANCHOR when relocated.
BEDROCK_Y = 100          # the walkable floor layer (bot stands at y=101)
BARRIER_Y = (101, 106)   # ring height range

CAM_POSE = "13 109 9 135 30"  # x y z yaw pitch — elevated 3/4 looking NW down at the base


def con(cmd: str) -> None:
    """Issue one server-console command (full op authority)."""
    subprocess.run([str(local_config.server_ctl()), "cmd", cmd], check=False,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.25)


def off(p):
    ax, ay, az = ANCHOR
    return (p[0] + ax, p[1] + ay, p[2] + az)


def bridge(port, cmd, params=None, timeout=20):
    return BridgeClient(port=port, timeout=timeout).send(cmd, params or {})


# Solid foundation so the scene is a real sandbox anywhere, not a floating slab.
# The fixture only fills a 1-block floor at y=100; in the live world the blocks
# below may be void/air (at origin the real ground is ~y=85), so the bot falls
# through. We fill solid stone from FLOOR_Y down to FOUNDATION_Y across an area
# slightly larger than the fixture footprint. This is what makes the demo
# relocatable — it manufactures ground regardless of the terrain below.
FLOOR_Y = 100
FOUNDATION_Y = 86
CLEAR_Y = 122  # top of the cleared airspace (kills intruding trees)
FOUNDATION_FOOTPRINT = ((-6, -7), (11, 6))  # (x0,z0),(x1,z1), a ring around the fixture


def build():
    """Stage terrain + furnaces + ore from the declarative fixture, via console."""
    (fx0, fz0), (fx1, fz1) = FOUNDATION_FOOTPRINT
    a = off((fx0, FOUNDATION_Y, fz0))
    b = off((fx1, FLOOR_Y, fz1))
    print(f"[build] foundation: solid stone {a} -> {b}")
    con(f"fill {a[0]} {a[1]} {a[2]} {b[0]} {b[1]} {b[2]} minecraft:stone")
    # Clear the airspace ABOVE + around the stage so surrounding trees/terrain don't
    # intrude and the camera has a clean sightline. Generous box up to CLEAR_Y.
    ca = off((fx0 - 4, FLOOR_Y + 1, fz0 - 4))
    cb = off((fx1 + 4, CLEAR_Y, fz1 + 4))
    print(f"[build] clear airspace {ca} -> {cb}")
    con(f"fill {ca[0]} {ca[1]} {ca[2]} {cb[0]} {cb[1]} {cb[2]} minecraft:air")
    spec = json.loads(ARENA.read_text())
    print(f"[build] applying {len(spec['ops'])} ops from {ARENA.name} @ anchor {ANCHOR}")
    for op in spec["ops"]:
        k = op["op"]
        if k == "clear":
            a, b = off(op["from"]), off(op["to"])
            con(f"fill {a[0]} {a[1]} {a[2]} {b[0]} {b[1]} {b[2]} minecraft:air")
        elif k == "fill":
            a, b = off(op["from"]), off(op["to"])
            con(f"fill {a[0]} {a[1]} {a[2]} {b[0]} {b[1]} {b[2]} {op['block']}")
        elif k == "set":
            p = off(op["pos"])
            con(f"setblock {p[0]} {p[1]} {p[2]} {op['block']}")
        elif k == "player":
            p = off(op["pos"])
            con(f"tp {BOT} {p[0]} {p[1]} {p[2]}")
        # clearinv / give / select: skipped — non-op bot; kit comes via supply()
    seal()
    clear_prospect_cache()
    print("[build] done")


def seal():
    """Make the sealed stage safe for an UNATTENDED loop: bedrock floor + barrier ring.

    Without these the bot (a) SCANs natural ore below the fixture's 1-block floor,
    digs a pit, then GOTO_GAVE_UP climbing back, and (b) once the local ore is gone,
    walks off toward a distant prospected vein and dies. The bedrock floor makes a pit
    physically impossible; the barrier ring makes wandering off impossible. Both are
    invisible-to-the-camera at the stage edges.
    """
    (fx0, fz0), (fx1, fz1) = FOUNDATION_FOOTPRINT
    a, b = off((fx0, BEDROCK_Y, fz0)), off((fx1, BEDROCK_Y, fz1))
    print(f"[seal] bedrock floor {a} -> {b}")
    con(f"fill {a[0]} {a[1]} {a[2]} {b[0]} {b[1]} {b[2]} minecraft:bedrock")
    y0, y1 = BARRIER_Y
    # Ring one block OUTSIDE the footprint so it never intrudes on the walkable stage.
    walls = [
        ((fx0 - 1, fz0 - 1), (fx1 + 1, fz0 - 1)),  # north edge
        ((fx0 - 1, fz1 + 1), (fx1 + 1, fz1 + 1)),  # south edge
        ((fx0 - 1, fz0 - 1), (fx0 - 1, fz1 + 1)),  # west edge
        ((fx1 + 1, fz0 - 1), (fx1 + 1, fz1 + 1)),  # east edge
    ]
    for (wx0, wz0), (wx1, wz1) in walls:
        a, b = off((wx0, y0, wz0)), off((wx1, y1, wz1))
        con(f"fill {a[0]} {a[1]} {a[2]} {b[0]} {b[1]} {b[2]} minecraft:barrier")
    print(f"[seal] barrier ring y{y0}..{y1}")


def clear_prospect_cache():
    """Zero the worker's prospected veins so the plan's `prospect` step no-ops.

    pickProspectVein reads BOTH `resources` (HV-prospector scan) AND `waypoints`
    (bot-recorded veins) for the active world section, so we clear both on every
    overworld section (the host string in the sig varies: localhost / 127.0.0.1).
    Bumps `seq` so the running worker re-reads the file (CAS guard).
    """
    path = worker_world_json()
    if path is None:
        print("[cache] worker instance dir unresolved — skipped")
        return
    if not path.exists():
        print(f"[cache] {path} missing — skipped")
        return
    d = json.loads(path.read_text())
    cleared = 0
    for key, sec in d.get("worlds", {}).items():
        if key.endswith("minecraft:overworld"):
            if sec.get("resources") or sec.get("waypoints"):
                cleared += 1
            sec["resources"] = []
            sec["waypoints"] = []
    d["seq"] = d.get("seq", 0) + 1000
    path.write_text(json.dumps(d))
    print(f"[cache] cleared {cleared} overworld section(s), seq={d['seq']}")


def supply():
    """Honest starter kit: op player drops the kit ONTO the bot -> auto-pickup."""
    cam = local_config.camera_account_name()
    spawn = off((0, 101, 0))
    # The camera must be droppable (not spectator) and standing on the bot for the pickup.
    con(f"gamemode survival {cam}")
    con(f"tp {cam} {spawn[0]} {spawn[1]} {spawn[2]}")
    for item, count in KIT:
        con(f"give {cam} {item} {count}")           # the camera is OP -> allowed
    time.sleep(1.0)
    # drop each hotbar stack; drop() throws them forward, so they scatter as
    # item entities rather than landing on the bot.
    for slot, (item, _count) in enumerate(KIT):
        try:
            bridge(CAM_PORT, "jeval", {"code": DROP_SLOT_JS.format(slot=slot)})
        except Exception as e:  # noqa: BLE001
            print(f"[supply] drop slot {slot} ({item}) failed: {e}")
        time.sleep(0.6)
    time.sleep(0.8)
    # Vacuum the scattered (legitimately-dropped) item entities onto the bot so it
    # picks them up. Still honest: these are the camera's dropped items, not /give'n.
    con(f"tp @e[type=item] {BOT}")
    time.sleep(1.0)
    print("[supply] kit dropped + vacuumed onto bot")


# select hotbar slot N on the op client, then drop the full stack (drop=fullStack).
# m_108700_ = LocalPlayer.drop(boolean); selected-slot field set via Inventory.selected.
DROP_SLOT_JS = (
    "var raw=Player.getPlayer().getRaw();"
    "var inv=raw[srg('Player','getInventory')]();"
    "inv[srg('Inventory','selected')]={slot};"
    "raw['m_108700_'](true);"
)


def storage():
    """Place + register the deposit chest so the plan's `store` step is productive."""
    p = off(CHEST)
    con(f"setblock {p[0]} {p[1]} {p[2]} minecraft:chest[facing={CHEST_FACING}]")
    time.sleep(0.5)
    try:
        r = bridge(BOT_PORT, "storage_add",
                   {"pos": [p[0], p[1], p[2]], "kind": "chest", "facing": CHEST_FACING})
        print(f"[storage] registered: {r}")
    except Exception as e:  # noqa: BLE001
        print(f"[storage] storage_add failed (store step will no-op): {e}")


def hud():
    """Hide the HUD on the OPERATOR camera for a clean cinematic (F1 equivalent).

    The camera is a jsMacros client, so we flip vanilla `Options.hideGui` over its
    bridge with the ext.js `srg()` helper (resolves the SRG field name in jeval).
    This also removes the jsMacros "Miner: …" overlay. Fail-LOUD: if the field
    resolution changes across a game/mapping bump this prints a clear warning rather
    than silently shipping a HUD-cluttered take — toggle F1 on the camera by hand then.
    """
    js = ("var o=Client.getMinecraft()[srg('Minecraft','options')];"
          "o[srg('Options','hideGui')]=true;"
          "JSON.stringify({hideGui:o[srg('Options','hideGui')]})")
    try:
        r = bridge(CAM_PORT, "jeval", {"code": js})
        print(f"[hud] hideGui -> {r}")
    except Exception as e:  # noqa: BLE001
        print(f"[hud] WARN could not hide HUD ({e}); toggle F1 on the camera manually")


def frame():
    """Park the bot at spawn and the operator camera at its cinematic pose."""
    cam = local_config.camera_account_name()
    spawn = off((0, 101, 0))
    con(f"tp {BOT} {spawn[0]} {spawn[1]} {spawn[2]} 180 0")
    cx, cy, cz, yaw, pitch = CAM_POSE.split()
    ax, ay, az = ANCHOR
    con(f"tp {cam} {int(cx)+ax} {int(cy)+ay} {int(cz)+az} {yaw} {pitch}")
    con(f"gamemode spectator {cam}")
    hud()
    print("[frame] bot parked + camera posed + HUD hidden")


def wait(timeout=180):
    """Block until the OPERATOR camera is IN-WORLD with its bridge (CAM_PORT) answering.

    capture_rig.sh fires its READY hook as soon as the MC *window* exists — which is at
    the title MENU, BEFORE the camera has joined the server and its jsMacros bridge is
    listening. `frame`/`supply`/`hud` then hit `[Errno 111] Connection refused`, so the
    HUD is not hidden and the kit is not dropped, and the take ships cluttered +
    unsupplied. The fix is to make this the FIRST
    line of the film hook: it polls the camera bridge until a `jeval` confirms the
    player is in-world (bridge listening AND world loaded), tolerating connection-refused
    while the bridge is still coming up. Fail-soft on timeout so a slow boot degrades to
    the old behaviour rather than aborting the whole take.
    """
    probe = "Player.getPlayer()!=null ? 'RIG_INWORLD_YES' : 'RIG_INWORLD_NO'"
    waited = 0
    while waited < timeout:
        try:
            if "RIG_INWORLD_YES" in str(bridge(CAM_PORT, "jeval", {"code": probe}, timeout=5)):
                print(f"[wait] camera in-world, bridge {CAM_PORT} ready (after {waited}s)")
                return
        except Exception:  # noqa: BLE001 — bridge not listening yet / not in-world; keep polling
            pass
        time.sleep(2)
        waited += 2
    print(f"[wait] TIMEOUT after {timeout}s — camera not confirmed in-world on {CAM_PORT}; "
          "continuing anyway (frame/supply may fail)")


def run():
    """Start the infinite sustain-cycle loop over the worker bridge."""
    r = bridge(BOT_PORT, "plan_start", {"name": "sustain-cycle"})
    print(f"[run] plan_start -> {r}")


def stop():
    try:
        print(f"[stop] {bridge(BOT_PORT, 'plan_abort', {})}")
    except Exception:  # noqa: BLE001
        print(f"[stop] {bridge(BOT_PORT, 'mission_abort', {})}")


def reset_furnaces():
    """Clear all three furnaces to EMPTY. Caller MUST plan_abort first (see lap())."""
    for (x, y, z) in (off(f) for f in FURNACES):
        con(f"setblock {x} {y} {z} minecraft:air")
        con(f"setblock {x} {y} {z} minecraft:furnace")


def refill_ore():
    """Re-plant the 25-block iron_ore patch (ORE_REGION) the previous lap mined out."""
    a, b = off(ORE_REGION[0]), off(ORE_REGION[1])
    con(f"fill {a[0]} {a[1]} {a[2]} {b[0]} {b[1]} {b[2]} minecraft:iron_ore")


def light_furnaces():
    """Set-dressing GLOW: force the outer two furnaces to actively smelt for the camera.

    The bot loads the CENTRE furnace (basePos) itself; the outer two are ambience so
    the whole bank glows regardless of the bot's per-lap load timing. Op-console
    data-merge (approved for filming) — the bot's own economy is untouched.
    """
    for f in (FURNACES[0], FURNACES[2]):
        x, y, z = off(f)
        con(f'data merge block {x} {y} {z} '
            '{BurnTime:1600s,CookTime:0,CookTimeTotal:200,'
            'Items:[{Slot:0b,id:"minecraft:raw_iron",Count:16b},'
            '{Slot:1b,id:"minecraft:coal",Count:8b}]}')


def lap():
    """Re-arm the sandbox for ONE clean autonomous plan lap, then start the plan.

    ORDER MATTERS: abort BEFORE resetting furnaces, or the still-running plan re-loads
    a furnace mid-reset and lap N+1 hits `furnace input full`. After re-arming, the
    plan autonomously does the real mine->goto->smelt work on camera.
    """
    try:
        bridge(BOT_PORT, "plan_abort", {})
    except Exception as e:  # noqa: BLE001
        print(f"[lap] plan_abort failed (continuing): {e}")
    time.sleep(1.0)
    reset_furnaces()
    refill_ore()
    spawn = off((3, 101, 1))
    con(f"tp {BOT} {spawn[0]} {spawn[1]} {spawn[2]} 90 0")
    time.sleep(0.5)
    light_furnaces()
    mark = journal_mark()  # the journal offset this lap's evidence has to appear AFTER
    # The FULL response, not r.get('result', r) — but be clear about what it is worth: the ack
    # is NOT a witness that the plan started. cmdPlanStart on an unknown plan logs
    # ORCH_PLAN_UNKNOWN and returns, and the dispatcher acks ok:true either way
    # (src/bot/orchestrator/index.ts cmdPlanStart + shared/kernel/capability.ts lastOutcome).
    # So print the whole envelope for the record, then go find real evidence.
    r = bridge(BOT_PORT, "plan_start", {"name": "sustain-cycle"})
    print(f"[lap] plan_start ack (NOT proof of start) -> {r}")
    plan_witness(mark)


def journal_mark() -> tuple[int, int] | None:
    """`(inode, end offset)` — the boundary this lap's evidence must appear after.

    An offset, not a copy of the tail: O(1) to take, and it cannot "roll out of the window" the
    way a remembered last LINE could. The INODE rides along because an offset alone is only
    meaningful against the same file: after a rotation the number still looks plausible against
    the new file's size, and seeking there lands in the MIDDLE of some unrelated line — which can
    hand back a fragment that still contains ORCH_PLAN_START and vouch for a lap that never
    started. journal_since() compares the inode first and re-windows when it changed.
    """
    path = worker_journal()
    if path is None:
        return None
    try:
        st = path.stat()
    except OSError as e:
        print(f"[journal] {path} unreadable: {e}")
        return None
    return (st.st_ino, st.st_size)


def journal_since(mark: tuple[int, int] | None) -> list[str] | None:
    """The journal lines appended after `mark`, or None if it could not be read.

    READ OFF DISK, not through the bridge. `get_logs` looks like a tail but main.js implements
    it as `Files.readAllLines()` + slice — a FULL read of a file that grows all shoot day,
    executed on the game's thread, and the witness called it TWICE per lap. The journal is
    host-local (same instance dir as the world cache), so one seek + one read of exactly the new
    bytes costs the game nothing and the host a few hundred bytes.

    NO RACE, BY CONSTRUCTION — no sleep, no retry: the bundle's log sink opens a BufferedWriter,
    writes the line and CLOSES it per line (src/core/runtime/jsmacros/io.ts `appendLine`), so a
    line is on disk before the tick that produced it can answer. "no-evidence" therefore means
    the worker really did not log the event, not that we read too early. (Which is the point:
    a `plan_start` ack proves nothing — see lap().)

    A mark that cannot be used (None, a different INODE, or an offset past EOF) falls back to the
    last JOURNAL_TAIL_BYTES and says why. That fallback can only be over-generous — the honest
    failure direction for a witness that must never invent evidence is to look at MORE than this
    lap, so the verdict names a stale event at worst, never a missing one — and, crucially, it
    always reads WHOLE lines from a window boundary rather than seeking into the middle of one.
    """
    path = worker_journal()
    if path is None:
        return None
    try:
        with path.open("rb") as fh:
            # fstat on the OPEN handle, not the path: it describes the very file being read, so
            # a rotation between the stat and the read cannot slip through.
            st = os.fstat(fh.fileno())
            size = fh.seek(0, os.SEEK_END)
            reason = None
            if mark is None:
                start = max(0, size - JOURNAL_TAIL_BYTES)
            elif mark[0] != st.st_ino:
                # ROTATED: a fresh file (possibly LARGER, so the offset looks valid) — seeking to
                # the old offset would cut a line in half and could vouch with the fragment.
                reason = f"rotated (inode {mark[0]} -> {st.st_ino})"
                start = max(0, size - JOURNAL_TAIL_BYTES)
            elif mark[1] > size:
                # TRUNCATED: the file shrank under us (a cleared journal). Seeking to a stale
                # offset would read NOTHING for the rest of the shoot — every lap "no-evidence"
                # while the bot works fine.
                reason = f"truncated under the mark ({mark[1]}B > {size}B)"
                start = max(0, size - JOURNAL_TAIL_BYTES)
            else:
                start = mark[1]
            if reason:
                # Name the FILE and its age here too: a re-windowed read can hand back a
                # confident STARTED that came from the OLD journal's last lines, and a verdict
                # sourced from a file nobody named is the kind of evidence that costs a shoot.
                print(f"[journal] {reason} — scanning the last {JOURNAL_TAIL_BYTES}B of "
                      f"{journal_path_note()} instead")
            fh.seek(start)
            blob = fh.read()
    except OSError as e:
        # Observability must never break the shoot: a missing/unreadable journal degrades to
        # "no-evidence", and the PATH is printed so a differently-named instance is diagnosable
        # (override it with MC_WORKER_JOURNAL) instead of quietly reporting nothing all day.
        print(f"[journal] {path} unreadable: {e}")
        return None
    return [ln for ln in blob.decode("utf-8", "replace").splitlines() if ln]


def journal_path_note() -> str:
    """`<path> (last written Ns ago)` — the diagnosis line for a witness that found nothing."""
    path = worker_journal()
    if path is None:
        return "no journal path (set MC_WORKER_JOURNAL)"
    try:
        age = time.time() - path.stat().st_mtime
    except OSError as e:
        return f"{path} ({e})"
    return f"{path} (last written {age:.0f}s ago)"


def plan_witness(mark: tuple[int, int] | None, tag: str = "lap") -> str:
    """Did the plan ACTUALLY start? Answer from the journal, printed as one verdict line.

    STARTED | UNKNOWN_PLAN | no-evidence. `mark` is the journal offset captured just before
    plan_start: only bytes appended AFTER it are considered, so a STARTED left over from the
    previous lap cannot vouch for this one.
    """
    fresh = journal_since(mark)
    if fresh is None:
        print(f"[{tag}] plan witness: no-evidence (journal unreadable) — {journal_path_note()}")
        return "no-evidence"
    verdict = "no-evidence"
    for text in fresh:  # append-only: the LAST of the two codes is this plan_start's
        if "ORCH_PLAN_START" in text:
            verdict = "STARTED"
        elif "ORCH_PLAN_UNKNOWN" in text:
            verdict = "UNKNOWN_PLAN"
    if verdict == "no-evidence":
        # A READABLE but STALE journal is the nastiest shape: the file opens fine, so nothing
        # errors, and every lap reports no-evidence all day while a live worker writes somewhere
        # else entirely (another instance, another macroFolder). Name the file and how old it is
        # — an age measured in the whole session's length IS the diagnosis.
        print(f"[{tag}] plan witness: no-evidence — read {journal_path_note()}")
    else:
        print(f"[{tag}] plan witness: {verdict}")
    return verdict


def probe_state(tag: str) -> None:
    """Print the WORKER's own mission truth — the second witness the shoot-day log was missing.

    Deliberately `mission_status`, NOT `get_state`: main.js's get_state reports the container's
    passive moduleState, which reads phase:null / running:false during a perfectly healthy live
    mission — it cannot tell a working bot from a dead one, and that exact blindness burned
    three fleet queues before scripts/ops/fleet_hub.py started overriding it from mission_status
    (see the comment there). The structured reply rides under result.data (ctx.reply()), so the
    fields are extracted and printed FIRST: the raw envelope used to be truncated at 300 chars,
    which cut the worker payload off entirely because it is the last key.

    Never raises: a probe that sank a lap would cost the take it was added to explain.
    """
    try:
        r = bridge(BOT_PORT, "mission_status", {}, timeout=8)
    except Exception as e:  # noqa: BLE001 — observability must not be able to break the shoot
        print(f"[{tag}] mission_status failed: {e}")
        return
    res = r.get("result") if isinstance(r, dict) and isinstance(r.get("result"), dict) else {}
    data = res.get("data") if isinstance(res.get("data"), dict) else {}
    if data:
        print(f"[{tag}] phase={data.get('phase')} running={bool(data.get('running'))} "
              f"active={data.get('active')}")
    else:
        print(f"[{tag}] mission_status carried NO worker data — the worker is deaf, not idle")
    print(f"[{tag}] raw: {json.dumps(r)[:1000]}")


DWELL_PROBE_S = 10  # how often the dwell asks the worker what phase it is in

# Per-lap dwell. 30 s = ~6 plan cycles (18 ore of the 25-block patch): the host re-arms BEFORE the
# patch runs dry, so the bot never enters the 114 s SCAN_EXHAUSTED freeze (see ORE_REGION).
# 40 s with a 9-block patch = 15 s of work + 25 s frozen per lap.
LAP_DWELL_S = 30


def loop():
    """Run host-paced clean laps for the camera. `loop [N]` — default: forever."""
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    secs = LAP_DWELL_S
    i = 0
    try:
        while n == 0 or i < n:
            i += 1
            print(f"=== lap {i}{'' if n == 0 else f'/{n}'} ===")
            lap()
            dwell(secs)
    except KeyboardInterrupt:
        print("\n[loop] interrupted — stopping plan")
        stop()


def dwell(secs: int) -> None:
    """Wait out one lap, polling the worker every DWELL_PROBE_S so the log is a TIMELINE.

    The old `time.sleep(secs)` left a 40-second hole in the driver log: when the take showed a
    motionless bot there was nothing to say whether the plan had finished early, ERRORed, or
    never started. Now every 10s the log records which phase the bot was in — line those stamps
    up against the take (or against motion_probe.py's static runs) and the freeze has an owner.

    DEADLINE form on purpose: the probes spend their time INSIDE the lap's budget, so adding
    observability did not lengthen the lap and slide the shot list. The only work outside the
    budget is the last probe itself, and lap() gave back more than that by dropping the 2s
    sleep it used to burn before its own probe.
    """
    deadline = time.monotonic() + secs
    while True:
        left = deadline - time.monotonic()
        if left <= 0:
            break
        time.sleep(min(DWELL_PROBE_S, left))
        probe_state(f"dwell +{secs - max(0.0, deadline - time.monotonic()):.0f}s")


STEPS = {"build": build, "supply": supply, "storage": storage, "wait": wait,
         "frame": frame, "hud": hud, "run": run, "loop": loop, "stop": stop}


def main():
    # shoot.py now runs this as a `during` driver with stdout redirected to a FILE, and a
    # redirected stdout is block-buffered: the driver is SIGTERM'd the moment the take ends,
    # so the last (most interesting) 4 KiB of the lap would die in the buffer unflushed.
    sys.stdout.reconfigure(line_buffering=True)
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    if what == "all":
        for name in ("build", "supply", "storage", "frame", "run"):
            print(f"=== {name} ===")
            STEPS[name]()
            time.sleep(1)
    elif what in STEPS:
        STEPS[what]()
    else:
        print(f"usage: {sys.argv[0]} {{{'|'.join(STEPS)}|all}}")
        sys.exit(2)


if __name__ == "__main__":
    main()
