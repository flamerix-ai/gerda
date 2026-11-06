import argparse
import hashlib
import re
import shutil
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Deploy the prebuilt TS bundle + standalone service harness to game instances.
#
# The bundle is built by tsup (`bun run build` → dist/__gerda_bot.bundle.js); this
# script only validates + copies. The legacy concat-from-SOURCES build was retired
# with the TS-kernel migration (runtime is GraalJS). Use `bun run deploy` for
# build+deploy in one step.
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parents[2]  # repo root (this file lives in scripts/ops/)

# Per-instance bridge port registry (mc-bots.json) — lives in scripts/.
sys.path.insert(0, str(ROOT / "scripts"))
import fleet_registry  # noqa: E402

# Default prebuilt bundle (tsup output).
DEFAULT_BUNDLE = ROOT / "dist" / "__gerda_bot.bundle.js"
# Standalone jsMacros services copied alongside the bundle (not bundled).
SERVICE_DIR = ROOT / "harness"
SERVICE_FILES = ["ipc.js", "safe-io.js", "world_store.js", "screen.js", "bridge.js", "main.js", "worker.js", "bot_template.js", "ext.js"]
# Optional generated data files deployed alongside the harness if present (not committed —
# e.g. srg_names.json, the SRG→Mojang map from `scripts/dev/srg.py --export`, used by `reflect`).
DATA_FILES = ["srg_names.json"]

MACRO_SUBPATH = Path("minecraft/config/jsMacros/Macros")

# Machine-specific: env MC_INSTANCES_ROOT > local.config.json > launcher autodetect. Resolved
# LAZILY (inside deploy()), never at import: `--validate-only` is the pre-push bundle gate and
# must run on a machine with NO game installed at all — a module-level lookup would SystemExit
# out of local_config before argparse ever saw the flag.
import local_config  # noqa: E402


# ---------------------------------------------------------------------------
# Bundle size budget, NOT a hard runtime limit: worker.js eval-loads the bundle with a plain eval()
# (no length check) — GraalJS evals far more than this. (The 256000 in main.js is a separate
# cap on the `eval` BRIDGE COMMAND's user-supplied snippets, which must stay small.) The budget
# exists to make bundle growth a deliberate decision: the largest single contributor is the
# live-registry ore set (config/ores_live.json — ore ids plus harvest-tier group ranks, inlined
# at build time), the rest is the kernel, navigator, capabilities and missions. Raise it in a
# commit that says what the new bytes buy; keep the bundle lean.
# Raises (one line each — old → new — why; `git log -S MAX_CODE_LEN` dates them):
#   592000 → 1048576 (1 MiB) — user decision: headroom for newcomers' extensions;
#   was 514 chars (a first capability or mission went over it at once).
# ---------------------------------------------------------------------------
MAX_CODE_LEN = 1048576


def list_target_dirs(instances_root: Path, macro_subpath: Path) -> list[Path]:
    """Find every instance that has a jsMacros Macros folder."""
    targets = []
    if not instances_root.exists():
        print(f"Instances root not found: {instances_root}")
        return targets
    for entry in instances_root.iterdir():
        macro_dir = entry / macro_subpath
        if macro_dir.is_dir():
            targets.append(macro_dir)
    return targets


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def validate_bundle(text: str) -> list[str]:
    """Reject a bundle that violates the worker's safeEval constraints."""
    errors = []
    if len(text) > MAX_CODE_LEN:
        errors.append(
            f"bundle size {len(text)} > MAX_CODE_LEN {MAX_CODE_LEN} (over by {len(text) - MAX_CODE_LEN})"
            " — a review budget, not a runtime limit: trim the bundle, or raise MAX_CODE_LEN in"
            " scripts/ops/sync.py with a line saying what grew (docs/EXTENDING.md § Bundle size budget)")
    if "var Module" not in text and "Module =" not in text:
        errors.append("missing 'Module' export — worker.js will reject it")
    elif (re.search(r"""^\s*["']use strict["']""", text, re.MULTILINE)
          and "globalThis.Module" not in text):
        # worker.js direct-evals the file; strict eval code keeps its own variable scope, so a
        # strict `var Module` never reaches the worker (the shipped bot_template.js did exactly
        # this once: every command answered "no module loaded").
        errors.append("strict-mode file exports only `var Module`, which stays inside worker.js's "
                      "eval — assign `globalThis.Module = …` instead")
    if re.search(r"\bwhile\s*\(\s*(true|!0|1)\s*\)|\bfor\s*\(\s*;\s*;", text, re.IGNORECASE):
        errors.append("infinite loop pattern found")
    if re.search(
        r"\bjava\.lang\.reflect\.|\bProcessBuilder\b|\bRuntime\.getRuntime\b",
        text,
        re.IGNORECASE,
    ):
        errors.append("dangerous Java interop found")
    return errors


def validate_only(bundle_path: Path) -> int:
    """Run the DEPLOY-time bundle gate without deploying (no instance discovery at all).

    This exists so the gate can run where it belongs — the pre-push hook, right after
    `bun run build` — instead of only at `just sync`. Before it, a bundle that violates
    validate_bundle (an unbounded loop header, a size-cap overrun) passed `bun run check`
    and the hooks and landed green, then blocked the next deploy for whoever ran it.
    Returns 0 when the bundle is clean, 1 on any error (missing file included).
    """
    # is_file(), not exists(): a directory passes exists() and then dies with a raw
    # IsADirectoryError traceback out of a GATE, which reads like the gate itself is broken.
    if not bundle_path.is_file():
        print(f"ERROR: bundle not found (or not a file): {bundle_path}")
        print("Build it first: bun run build")
        return 1
    text = bundle_path.read_text("utf-8")
    errors = validate_bundle(text)
    if errors:
        print(f"BUNDLE VALIDATION FAILED: {bundle_path}")
        for e in errors:
            print("  - " + e)
        return 1
    print(f"Bundle OK: {bundle_path} ({len(text)}/{MAX_CODE_LEN} chars)")
    return 0


def _write_if_changed(path: Path, text: str, label: str) -> None:
    new_hash = content_hash(text)
    if path.exists() and content_hash(path.read_text("utf-8")) == new_hash:
        print(f"No changes for {label}")
        return
    path.write_text(text, "utf-8")
    print(f"Deployed {new_hash} → {path}")


def deploy(
    bundle_path: Path,
    out_name: str = "__gerda_bot.bundle.js",
    base_port: int = fleet_registry.DEFAULT_BASE_PORT,
    skip: list[str] | None = None,
    only: list[str] | None = None,
) -> int:
    """Validate the bundle, then copy it + the service files to every instance.

    `skip` is a list of launcher INSTANCE DIRECTORY names (e.g. "Monifactory_cam_shader")
    that receive nothing — no bundle, no bridge_port.txt, no service files. See docs/RIG.md
    (Film § 0): rewriting the harness files under a RUNNING camera client makes jsMacros
    restart the service, closing the GraalJS context out from under the per-frame Forge
    listener registered in harness/ext.js — which has no unregister path in 1.20.1 and keeps
    firing into the dead context until the render thread crashes the client.
    """
    text = bundle_path.read_text("utf-8")
    if out_name == "__gerda_bot.bundle.js":
        errors = validate_bundle(text)
        if errors:
            print("BUNDLE VALIDATION FAILED:")
            for e in errors:
                print("  - " + e)
            return 1

    root = local_config.instances_root()
    targets = list_target_dirs(root, MACRO_SUBPATH)
    if not targets:
        print(f"No deploy targets under {root}: no <instance>/{MACRO_SUBPATH.as_posix()}/ folder.\n"
              "Install jsMacros into the instance and start the game once — jsMacros creates the"
              " folder — then run this again (docs/SETUP.md, Quickstart steps 3-4).")
        return 1

    # Reconcile per-instance bridge ports (stable across deploys) and record the
    # fleet registry. The instance root is the macro dir's 4th parent (…/<inst>/minecraft/
    # config/jsMacros/Macros). bridge_port.txt is dropped per instance below so bridge.js
    # binds a distinct port — without it, a 2nd co-located bot fails to bind 55544.
    instances = [(dst.parents[3].name, dst.parents[3]) for dst in targets]

    # Fail LOUD on a --skip that matches nothing: a typo'd instance name would otherwise
    # deploy into the very client the flag exists to protect, and the only symptom would be
    # that crash five seconds later. Checked BEFORE assign() so a refused run leaves the
    # registry untouched.
    skip_names = list(skip or [])
    known = sorted({name for name, _ in instances})
    # --only is --skip of every other instance: same checks, same registry handling. A custom
    # bundle (`-s`) meant for one instance otherwise landed in every instance of the root, and a
    # second running bot picked it up on its next worker reload.
    if only:
        unknown_only = sorted({s for s in only if s not in known})
        if unknown_only:
            print(f"ERROR: --only names no such instance: {', '.join(unknown_only)}")
            print(f"Known instances: {', '.join(known)}")
            return 1
        skip_names = [n for n in known if n not in only]
    unknown = sorted({s for s in skip_names if s not in known})
    if unknown:
        print(f"ERROR: --skip names no such instance: {', '.join(unknown)}")
        print(f"Known instances: {', '.join(known)}")
        return 1
    if skip_names and len(set(skip_names)) == len(known):
        print(f"ERROR: --skip covers every discovered instance ({', '.join(known)}) — nothing to deploy.")
        return 1

    # assign() gets ALL discovered instances, skipped ones INCLUDED: it REBUILDS mc-bots.json
    # from exactly the list it is handed, so dropping a skipped instance here would delete its
    # registry entry and free its port for the next newly-seen instance — i.e. `--skip` would
    # silently renumber the fleet and break `bridge_ctl --bot <name>` for the skipped bot.
    # Skipping is a FILE-WRITE filter only; the port registry is identical with and without it.
    dir_port = fleet_registry.assign(instances, base_port=base_port)
    print(f"Fleet registry → {fleet_registry.registry_path()} ({len(dir_port)} bot(s))")

    present_data = [d for d in DATA_FILES if (SERVICE_DIR / d).exists()]
    if out_name == "__gerda_bot.bundle.js":
        for data in DATA_FILES:
            if data not in present_data:
                # Generated + gitignored, so tree-local: absent in a fresh worktree. Say so (once,
                # not per instance) rather than skip silently — instances keep an older sync's copy.
                print(f"Skipped data {data} (absent in {SERVICE_DIR}; generate it first)")

    for dst in targets:
        inst_name = dst.parents[3].name
        if inst_name in skip_names:
            print(f"Skipped {inst_name} (--skip): no bundle, no services, no bridge_port.txt")
            continue
        _write_if_changed(dst / out_name, text, dst.name)
        # Service harness travels with the bundle (only on a full bundle deploy).
        if out_name == "__gerda_bot.bundle.js":
            port = dir_port.get(str(dst.parents[3]))
            if port is not None:
                _write_if_changed(
                    dst / "bridge_port.txt", f"{port}\n", f"{dst.parents[3].name} bridge_port={port}"
                )
            for svc in SERVICE_FILES:
                src = SERVICE_DIR / svc
                if src.exists():
                    shutil.copy2(src, dst / svc)
                    print(f"Deployed service → {dst / svc}")
            for data in present_data:
                shutil.copy2(SERVICE_DIR / data, dst / data)
                print(f"Deployed data → {dst / data}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Deploy the prebuilt miner bundle + services to Minecraft instances"
    )
    parser.add_argument(
        "-s",
        "--source",
        type=Path,
        default=None,
        help="Bundle file to deploy (default: dist/__gerda_bot.bundle.js)",
    )
    parser.add_argument(
        "-n",
        "--name",
        type=str,
        default="__gerda_bot.bundle.js",
        help="Output filename (default: __gerda_bot.bundle.js)",
    )
    parser.add_argument(
        "--validate-only",
        nargs="?",
        const="",  # bare flag → the default bundle (or whatever -s points at)
        default=None,
        metavar="PATH",
        help="Validate a bundle and exit 0/1 WITHOUT deploying (pre-push gate; needs no game "
        "instance). Optional PATH overrides dist/__gerda_bot.bundle.js",
    )
    which = parser.add_mutually_exclusive_group()
    which.add_argument(
        "--only",
        action="append",
        default=None,
        metavar="INSTANCE",
        help="Deploy into this launcher instance only (repeatable); every other instance is "
        "skipped as with --skip. Use it for a custom bundle (-s) meant for one bot. An unknown "
        "name is an error.",
    )
    which.add_argument(
        "--skip",
        action="append",
        default=None,
        metavar="INSTANCE",
        help="Launcher instance directory name to EXCLUDE from this deploy (repeatable). Use it "
        "to deploy while a camera client is running: rewriting the harness files under a live "
        "client restarts its jsMacros services and crashes a camera (docs/RIG.md § 0). An "
        "unknown name is an error, never a silent no-op.",
    )
    parser.add_argument(
        "--bridge-base-port",
        type=int,
        default=fleet_registry.DEFAULT_BASE_PORT,
        help=f"Lowest bridge port to hand to new instances (default: {fleet_registry.DEFAULT_BASE_PORT})",
    )
    args = parser.parse_args()

    if args.validate_only is not None:
        # -n only names a DEPLOY output file, and deploy() deliberately skips validation for a
        # non-default one — so `--validate-only -n foo.js` would silently mean something other
        # than it reads. Refuse the combination instead of ignoring half of it.
        if args.name != "__gerda_bot.bundle.js":
            parser.error("--validate-only validates a file in place; -n/--name has no meaning here")
        # Same reasoning for --skip: validate-only never discovers an instance, so a skip list
        # would read as "I protected the camera" while protecting nothing.
        if args.skip or args.only:
            flag = "--skip" if args.skip else "--only"
            parser.error(f"--validate-only deploys nothing; {flag} has no meaning here")
        # `--validate-only PATH` wins over -s; the bare flag falls back to -s, then the default.
        explicit = Path(args.validate_only) if args.validate_only else None
        return validate_only(explicit or args.source or DEFAULT_BUNDLE)

    bundle_path = args.source or DEFAULT_BUNDLE
    if not bundle_path.exists():
        print(f"ERROR: bundle not found: {bundle_path}")
        print("Build it first: bun run build")
        return 1

    rc = deploy(bundle_path, args.name, base_port=args.bridge_base_port, skip=args.skip, only=args.only)
    if rc == 0:
        print("Done.")
    return rc


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(1)
