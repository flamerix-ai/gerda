#!/usr/bin/env python3
"""Bind each launcher Monifactory instance to a FIXED account, so no instance
ever rides the globally-active account (which caused a bot-vs-human collision on the
maintainer's own machine — the account NAME involved is machine-specific, not a fixed value).

Sets, per instance.cfg:
    UseAccountForInstance=true
    InstanceAccountId=<profile id from accounts.json>

RUN THIS WITH THE LAUNCHER GUI CLOSED — an open GUI holds instance.cfg in memory and
rewrites it on instance-exit / GUI-close, which would clobber these edits. Running
instances (the MC processes) are NOT affected; the binding applies on their next launch.

Idempotent: re-running just re-asserts the same keys.

Machine-specific mapping: the human-play instance name/account come from local.config.json
(`humanInstance` / `humanAccountName`, env override MC_HUMAN_INSTANCE / MC_HUMAN_ACCOUNT_NAME),
and the shader camera's OP account from `cameraAccountName` (env MC_CAMERA_ACCOUNT_NAME) —
see local.config.json.example. The bot_N instances/accounts are fixed by convention, and so is
the shader camera's instance name `Monifactory_cam_shader` (bound to the camera account; the
convention is stated in docs/RIG.md § Shader camera instance — under any other name, bind it by hand).
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # scripts/ root
import local_config  # noqa: E402

if __name__ == "__main__":
    # Parse before the machine config below resolves: `-h` must work with no launcher yet.
    argparse.ArgumentParser(description=__doc__,
                            formatter_class=argparse.RawDescriptionHelpFormatter).parse_args()

BASE = local_config.instances_root()

HUMAN_INSTANCE = local_config.get("humanInstance", "Monifactory")
HUMAN_ACCOUNT_NAME = local_config.get("humanAccountName")
if not HUMAN_ACCOUNT_NAME:
    raise SystemExit(
        "local.config.json is missing \"humanAccountName\" (or env MC_HUMAN_ACCOUNT_NAME) — "
        "the offline-account profile NAME (from accounts.json) that the human's own "
        f"{HUMAN_INSTANCE!r} instance should be bound to. Copy local.config.json.example to "
        "local.config.json and add it, or export MC_HUMAN_ACCOUNT_NAME=<name>."
    )
CAMERA_ACCOUNT_NAME = local_config.camera_account_name()  # loud SystemExit when unset

# instance dir -> account profile name (id resolved from accounts.json below)
MAPPING = {
    HUMAN_INSTANCE: HUMAN_ACCOUNT_NAME,
    "Monifactory_bot_1": "bot_1",
    "Monifactory_bot_2": "bot_2",
    "Monifactory_bot_3": "bot_3",
    "Monifactory_bot_4": "bot_4",
    # The shader camera (docs/RIG.md § Shader camera instance) is a variant of Monifactory_bot_2
    # and is only ever booted as the CAMERA, i.e. on the op camera account — so it is bound to
    # `cameraAccountName`, the account capture_rig.sh gets with `-a` for camera takes. (Monifactory_bot_2
    # itself stays bound to `bot_2`: it is the bot instance that a camera launch overrides at boot.)
    # Same account + same pinned bridge port as bot_2 = never boot the two together.
    "Monifactory_cam_shader": CAMERA_ACCOUNT_NAME,
}


def account_ids() -> dict[str, str]:
    """name -> InstanceAccountId value in the launcher's own format `<profileId>:<type>`.

    The launcher stores the per-instance account as `<id>:<type>` (e.g. `49d7…:offline`),
    NOT a bare id. Writing just the id makes the launcher treat the binding as unset and fall
    back to the globally-active account — the bug that booted a bot as the human's own account.
    """
    import json

    d = json.loads((BASE.parent / "accounts.json").read_text())
    out = {}
    for a in d.get("accounts", []):
        prof = a.get("profile", {})
        if prof.get("name") and prof.get("id"):
            suffix = str(a.get("type", "offline")).lower()  # Offline -> offline
            out[prof["name"]] = f"{prof['id']}:{suffix}"
    return out


def set_key(lines: list[str], key: str, value: str) -> list[str]:
    """Set key=value, collapsing ANY existing occurrences to a single line (dedupe).

    Dedupe matters: the launcher appends its OWN `InstanceAccountId=<active>:offline` line on
    launch. If our line coexists with it, the launcher reads the first/valid one (the active
    account) and our binding is silently ignored — the exact bug that let bot_1 boot as the human's own account.
    """
    prefix = f"{key}="
    kept: list[str] = []
    seen = False
    for ln in lines:
        if ln.startswith(prefix):
            if not seen:
                kept.append(f"{key}={value}")
                seen = True
            # drop any further duplicates
        else:
            kept.append(ln)
    if not seen:
        kept.append(f"{key}={value}")
    return kept


def main() -> int:
    ids = account_ids()
    missing = [name for name in MAPPING.values() if name not in ids]
    if missing:
        print(f"ERROR: accounts missing from accounts.json: {missing}", file=sys.stderr)
        return 1

    for inst, acct in MAPPING.items():
        cfg_path = BASE / inst / "instance.cfg"
        if not cfg_path.exists():
            print(f"SKIP {inst}: no instance.cfg")
            continue
        lines = cfg_path.read_text().splitlines()
        lines = set_key(lines, "UseAccountForInstance", "true")
        lines = set_key(lines, "InstanceAccountId", ids[acct])
        cfg_path.write_text("\n".join(lines) + "\n")
        print(f"OK   {inst:20} -> {acct} ({ids[acct]})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
