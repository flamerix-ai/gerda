---
name: gerda-run
description: Boot ONE Gerda bot client off-screen and drive it for regular offline work — missions/plans, prospecting, fleet tasks — with NO camera and nothing on the user's monitor. Use when asked to "run / start the bot", drive a mission or plan, or do headless bot work (not filming).
---

# gerda-run

Follow **`docs/RIG.md` § Run**. For commands, missions, plans and fleet driving read
`docs/FLEET_PLAYBOOK.md` and `docs/EXTENDING.md`; this skill covers getting a client up.

The instance, account and bridge port below are the `docs/RIG.md` § Shared topology worker
defaults (`Monifactory_bot_1` / `bot_1` / 55545); ports come from the machine-local
`mc-bots.json`, so substitute your own if they differ.

1. **Server up:** `"$(python3 scripts/local_config.py server_ctl)" status` (root from `serverRoot`
   in `local.config.json` or env `MC_SERVER_ROOT`; see `docs/SERVER_SETUP.md`). Nobody else is
   logged in on the bot's account.
2. **Boot one client, keep-alive, no recording:**
   `nix develop .#capture -c scripts/ops/capture_rig.sh -a bot_1 -l Monifactory_bot_1 -s localhost:25565 -K &`
   (drop `-s` for single-player).
3. **Wait for the bridge:** `python3 scripts/ops/bridge_ctl.py --port 55545 --wait-ready 120 status`.
   Then drive with `scripts/ops/bridge_ctl.py` or the `mc` MCP tools (`mc_get_state` / `mc_send` /
   `mc_fleet_*`).
4. **Tear down:** `scripts/rig/teardown.sh Monifactory_bot_1`.

Rules:

- The bot plays like a real player: no cheats, no handouts. Its only server privilege is teleport.
- Check which client is on a bridge port before driving it (`eval`
  `Player.getPlayer().getName().getString()` names the player); the default bridge port 55544
  is usually your own client, not a bot.
- Boot a second client only after the first one's bridge answers.
- Never `pkill -f` an instance name (it kills your own shell); use `teardown.sh`.
