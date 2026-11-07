---
name: gerda-film
description: Record a cinematic demo of the Gerda bot doing real work (mine→smelt→restock) fully autonomously and hands-free — off-screen camera client, staged scene on the dedicated server, sustain-cycle plan, encoded deliverable. Use when asked to "film / record / make a video / capture a demo" of the bot.
---

# gerda-film

Follow **`docs/RIG.md` § Film** step by step. It is the procedure; do not improvise the capture
path.

Prerequisites (`docs/RIG.md` § Shared topology): the dedicated server from
`docs/SERVER_SETUP.md`, the worker and camera instances synced (`just sync`), and
`local.config.json` with `cameraAccountName` (the op camera account; env
`MC_CAMERA_ACCOUNT_NAME`) and, if the server is not at the default
`python3 scripts/local_config.py server_dir`, `serverRoot` (env `MC_SERVER_ROOT`). The demo
scripts refuse to run without them — set them, never guess a name.

Instance names, accounts and bridge ports below are the `docs/RIG.md` § Shared topology
defaults (worker `Monifactory_bot_1` / `bot_1` / 55545, camera `Monifactory_bot_2` / 55546).
Ports come from the machine-local `mc-bots.json`; substitute your own if they differ.

Shape (exact commands in the doc):

1. **Boot the worker alone** (`capture_rig.sh -a bot_1 -l Monifactory_bot_1 -s localhost:25565 -K`)
   and wait for its bridge with `bridge_ctl.py --port 55545 --wait-ready 90 status`.
2. **Stage** from the server console: `scripts/demo/sustain_live.py build`.
3. **Boot the camera** on the op account (`-a "$(python3 scripts/local_config.py camera_account_name)"`,
   `ALLOW_CONCURRENT=1`, `-K`) with a READY hook (`-H`). The hook's first line is
   `sustain_live.py wait`; then `supply`, `storage`, `frame` (last: it restores the camera pose
   that `supply` moves), and `scripts/rig/record.sh` on `HEADLESS-1`
   while `sustain_live.py loop N` runs laps. Keep the hook and raw take in `$RIG_TMP`.
4. **Encode:** `scripts/rig/encode.sh "$RIG_TMP/sustain_raw.mp4" <out.mp4>`.
5. **Verify** (ffprobe, a few frames, `scripts/rig/motion_probe.py`), then **tear down**:
   `scripts/rig/teardown.sh Monifactory_bot_1 Monifactory_bot_2`.

Rules:

- The bot plays like a real player: no cheats. What the filmed scenes hand it is listed in
  `docs/RIG.md` § What the filmed scenes stage.
- Deploy before the camera boots; with the camera up use `just sync --skip <camera instance>`.
- Capture through headless sway only.
- Never `pkill -f` an instance name; use `teardown.sh`.
- Boot the camera with `-K`: the hook's `record.sh` owns the recording.
