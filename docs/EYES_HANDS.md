# Eyes & hands: screenshots and GUI input

The harness lets you see the game and work its menus over the bridge. You can take a screenshot,
read it, click a button, scroll a list and type into a text field. Nothing needs the mouse, the
keyboard or even a visible window. This page is for a developer or an LLM operator who drives a
client through `./gerda ctl` or the `mc_send` MCP tool.

All commands below are container commands in `harness/screen.js`, plus the EMI commands in
`harness/ext.js`. `./gerda ctl send <type> '<json>'` sends any of them from a shell. From MCP, use
`mc_send` with the same type and payload. To reach a bot client instead of the default port, add
`--port <port>` or `--bot <name>` before `send`.

## Eyes: screenshots

### Take one

```bash
./gerda ctl send screenshot                     # writes <instance>/minecraft/screenshots/ai_shot.png
./gerda ctl send screenshot '{"name": "a.png"}' # any other file name
```

The command calls jsMacros `Player.takeScreenshot` on the render thread. It captures the game's own
framebuffer, so it sees every GUI, including custom-rendered ones (FTB Quests, GregTech machine
screens). The file is overwritten on every call.

The reply comes back before the file is written. Wait about a second before you read it, or
compare `mtime` from `latest_screenshot` (path and modification time of the newest PNG).

!!! warning "Off-screen frames need `enableVsync:false`"
    Set `enableVsync:false` in the instance's `options.txt`. With vsync on, a window that is
    hidden, minimized or off-screen stops rendering, and every screenshot shows the same stale
    frame.

### Read one

`./gerda shot` (= `python3 scripts/ops/mc_shot.py`) resizes and crops a shot into one output file,
`/tmp/mc_shot.png` by default:

```bash
./gerda shot --file -s 0.4                     # ai_shot.png, scaled to 40%
./gerda shot --file -g "730,320 1100x800"      # one region, full resolution
./gerda shot --file a.png -s 0.5 -o out.png    # another file, another output path
./gerda shot --latest                          # newest PNG in screenshots/ (e.g. an F2 press)
```

| Flag | Meaning |
|---|---|
| `--file [NAME]` | Read `screenshots/NAME` (default `ai_shot.png`). |
| `--latest` | Read the newest PNG in `screenshots/`. |
| `-s SCALE` | Downscale factor (default `0.5`). |
| `-g "X,Y WxH"` | Crop a region, in full-resolution pixels. The crop runs before the scale. |
| `-o OUT` | Output path (default `/tmp/mc_shot.png`). |

The file modes need `ffmpeg`. By default they read the human instance named by `humanInstance`
in `local.config.json`. To read a bot or camera client, point `MC_INST` at that instance's
`minecraft` directory (an absolute path). Without it you get the human instance's old
`ai_shot.png`, not the frame you just took:

```bash
MC_INST=/path/to/instances/<bot instance>/minecraft ./gerda shot --file -s 0.33
```

Without `--file` or `--latest`, `mc_shot.py` grabs the visible window from the desktop instead.
That mode is optional and works only on a niri (Wayland) session with `grim`. The in-game
`screenshot` command plus `--file` works everywhere.

### Keep the cost down (LLM operators)

An image costs tokens by its pixel count, not its file size. JPEG does not help. On a window about
2560 pixels wide:

| Shot | Approx. tokens |
|---|---|
| `-s 0.5` | 1,200 |
| `-s 0.33` | 530 |
| `-s 0.25` | 300 |
| tight `-g` crop | 100 |

Take a small overview first. Then crop the part you need at full resolution.

Before you take a screenshot at all, ask whether a data command answers the question.
`read_screen` lists a vanilla screen's buttons. `emi_search` returns item ids. The FTB quest
files sit on disk. Each is cheaper than an image.

## Coordinates

There are two coordinate systems:

- **Framebuffer pixels.** The screenshot is the full framebuffer, so its size is the game window's
  size in pixels (for example 2544×1392). It is not your monitor's size.
- **GUI coordinates.** These are what `click` and `scroll` take. A GUI coordinate is a framebuffer
  pixel divided by the GUI scale.

```
gui_x = framebuffer_x / guiScale
gui_y = framebuffer_y / guiScale
```

Set an explicit `guiScale` in `options.txt` (our instances use `4`). With `0` (auto), the scale
changes with the window size. Minecraft also lowers the scale when the window is too small for it:
scale `n` needs a window of at least `320·n × 240·n` pixels, so `4` needs 1280×960.

Convert from the image you actually read:

- A shot taken with `-s s` shows pixel `p` for framebuffer pixel `p / s`.
- A shot cropped with `-g "X,Y WxH"` is offset: framebuffer `x = X + p / s`, `y = Y + p / s`.

Example: a downscaled shot (`-s 0.5`) shows a button at (424, 280). That is framebuffer (848, 560),
so you click GUI (212, 140) at `guiScale:4`.

## Hands: GUI input

| Command | Payload | What it does |
|---|---|---|
| `read_screen` | — | Title and button widgets (`i`, `text`, `x`, `y`, `w`, `h`, `active`) of the open screen; `open:false` in the world. |
| `click` | `{i}` or `{text}` | Click a standard button by index or by a label substring. |
| `click` | `{x, y, button?}` | Mouse click at GUI coordinates. `button` 0 = left (default), 1 = right. |
| `scroll` | `{x, y, amount?}` | Scroll at GUI coordinates. Positive is up, negative is down; default `-3`. |
| `type` | `{text}` | Type text into the focused widget. Click the text field first. |
| `keypress` | `{code, scancode?, mods?}` | Send a GLFW key to the open screen: Enter `257`, Backspace `259`, Escape `256`, Tab `258`, arrows `262`–`265`. |
| `key` | `{key, hold?, release?}` | Tap a named keybind (`key.inventory`, `key.use`, `key.drop`). `hold:true` keeps it down until a `release:true` call. |
| `close_screen` | — | Close the open screen. |
| `introspect` | `{target?, filter?}` | Debug: list method names on the jsMacros libraries, or on the open screen with `target:"screen"`. |

```bash
./gerda ctl send read_screen
./gerda ctl send click '{"text": "Done"}'
./gerda ctl send click '{"x": 212, "y": 140}'
./gerda ctl send scroll '{"x": 212, "y": 140, "amount": -5}'
./gerda ctl send type '{"text": "iron"}'
./gerda ctl send keypress '{"code": 257}'
```

`click`, `scroll`, `type` and `keypress` call the real vanilla `Screen` methods
(`mouseClicked`/`mouseReleased`, `mouseScrolled`, `charTyped`, `keyPressed`/`keyReleased`). They
run on the render thread, so the reply means "scheduled", not "done". Take a screenshot to see the
result. At runtime Forge exposes these methods only under their SRG names; the harness keeps that
table, and [Extending § SRG-mapping workflow](EXTENDING.md#srg-mapping-workflow-calling-vanillaforge-methods)
explains it.

`read_screen` sees standard widgets only. A custom-rendered GUI reports `open:true`, an empty
title and no buttons. Use a screenshot there.

## Which GUIs accept synthetic input

| GUI | Synthetic `click` / `scroll` / `type` | What to do |
|---|---|---|
| Vanilla screens: containers, buttons, anvil and sign text fields | Yes | Use the commands above. |
| FTB Library screens, such as the FTB Quests book | Yes, at the coordinates you pass | Click quest nodes and scroll the tree directly. |
| EMI or JEI overlays: the item list and its search bar | **No** | Use the `emi_*` commands below. |

Vanilla and FTB Library screens take the coordinates from the call. They need no OS cursor and no
window focus. EMI and JEI hit-test the real OS cursor and read the keyboard below the screen, so
synthetic events never reach them.

## EMI as data

EMI's classes keep their real names on Forge, so `harness/ext.js` calls its Java API directly.

| Command | Payload | Result |
|---|---|---|
| `emi_search` | `{text, limit?}` | Matching item ids as data, for example `results: ["minecraft:iron_ingot", …]`. `limit` defaults to 60. |
| `emi_recipe` | `{item}` | Opens the recipe screen for what **crafts** the item. |
| `emi_uses` | `{item}` | Opens the recipe screen for where the item is **used**. |

```bash
./gerda ctl send emi_search '{"text": "@gtceu raw"}'
./gerda ctl send emi_recipe '{"item": "minecraft:iron_ingot"}'
```

`emi_search` needs no screen, no screenshot and no focus. It accepts the full EMI query syntax
(`@mod`, `#tag`, tooltip text). It waits about 8 ticks for EMI's background search, then reads the
result. It also leaves your text in EMI's search bar. Use it to find out which items exist instead
of reading the item panel from an image.

`emi_recipe` and `emi_uses` open a screen. Read it with a screenshot, then `close_screen`.

## FTB Quests

The quest book is an FTB Library screen. `click` and `scroll` work on it, and `read_screen` is
blind to it. Read the quest tree from disk instead of from screenshots:

- `<instance>/minecraft/config/ftbquests/quests/chapters/*.snbt` holds the quest ids, `x`/`y`
  grid positions, `dependencies`, task `type` and items.
- Title keys such as `{moni.quest.*}` and `{moni.task.*}` resolve through
  `<instance>/minecraft/kubejs/assets/ftbquests/lang/en_us.json`. Other packs keep their own lang
  file.

A `checkmark` task completes when you click it. An item task completes when the player holds the
item. To read quest state and to complete or claim quests without the GUI, use the bridge
commands in [Fleet playbook § FTB Quests](FLEET_PLAYBOOK.md#3-ftb-quests-read-complete-claim).

## A reliable loop

1. `screenshot`, then `./gerda shot --file -s 0.33` for an overview.
2. Crop tightly around the target with `-g` at full resolution, and find its centre.
3. Convert the centre to framebuffer pixels, then divide by `guiScale`.
4. `click {x, y}`.
5. `screenshot` again and check that the screen changed the way you expected.

Repeat from step 1 when it did not. A click that lands but does nothing usually means the
coordinates are off by the scale factor, or the screen is an EMI or JEI overlay.
