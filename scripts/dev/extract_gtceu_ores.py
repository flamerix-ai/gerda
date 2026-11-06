#!/usr/bin/env python3
"""Extract GTCEu ore block IDs from GitHub source.

Downloads GTCEu material definition files and parses .ore() calls
to generate a typed list of block IDs per stone type.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
from dataclasses import asdict, dataclass
from urllib.request import urlopen
from urllib.error import HTTPError

REPO_ROOT = (
    "https://raw.githubusercontent.com/GregTechCEu/GregTech-Modern/1.20.1"
)
MATERIAL_FILES = [
    "src/main/java/com/gregtechceu/gtceu/common/data/materials/ElementMaterials.java",
    "src/main/java/com/gregtechceu/gtceu/common/data/materials/FirstDegreeMaterials.java",
    "src/main/java/com/gregtechceu/gtceu/common/data/materials/SecondDegreeMaterials.java",
    "src/main/java/com/gregtechceu/gtceu/common/data/materials/HigherDegreeMaterials.java",
    "src/main/java/com/gregtechceu/gtceu/common/data/materials/UnknownCompositionMaterials.java",
]

# Stone types used by GTCEu ore generation
STONE_TYPES = ["", "deepslate_", "netherrack_", "endstone_"]

# Regex to match .ore() calls and preceding material name
ORE_RE = re.compile(
    r'new Material\.Builder\(GTCEu\.id\("([^"]+)"\)\)'
    r'[^;]*?\.ore\([^)]*\)',
    re.DOTALL,
)

# Regex to match direct variable assignment before builder
# e.g.  Aluminium = new Material.Builder(...)
VAR_RE = re.compile(r'^\s+(\w+)\s*=\s*new', re.MULTILINE)


@dataclass
class OreConfig:
    overworld: list[str]
    deepslate: list[str]
    nether: list[str]
    end: list[str]
    raw_materials: list[str]


def fetch(url: str) -> str | None:
    try:
        with urlopen(url, timeout=30) as resp:
            return resp.read().decode("utf-8")
    except HTTPError as e:
        print(f"ERROR: {url} -> {e.code}", file=sys.stderr)
        return None


def parse_ore_materials(text: str) -> set[str]:
    """Return set of material IDs that have .ore() in their builder chain."""
    found = set()
    for m in ORE_RE.finditer(text):
        found.add(m.group(1))
    return found


def build() -> OreConfig:
    all_materials: set[str] = set()

    for path in MATERIAL_FILES:
        url = f"{REPO_ROOT}/{path}"
        print(f"Fetching {path}...")
        text = fetch(url)
        if text is None:
            continue
        ores = parse_ore_materials(text)
        print(f"  Found {len(ores)} ore materials")
        all_materials.update(ores)

    print(f"\nTotal unique ore materials: {len(all_materials)}")

    return OreConfig(
        overworld=sorted(f"gtceu:{m}_ore" for m in all_materials),
        deepslate=sorted(f"gtceu:deepslate_{m}_ore" for m in all_materials),
        nether=sorted(f"gtceu:netherrack_{m}_ore" for m in all_materials),
        end=sorted(f"gtceu:endstone_{m}_ore" for m in all_materials),
        raw_materials=sorted(all_materials),
    )


def main() -> int:
    argparse.ArgumentParser(
        description=__doc__ + "\nWrites config/gtceu_ores.json (tracked) — review the diff.",
        formatter_class=argparse.RawDescriptionHelpFormatter).parse_args()
    root = pathlib.Path(__file__).resolve().parents[2]  # repo root (this file lives in scripts/dev/)
    config_dir = root / "config"
    config_dir.mkdir(parents=True, exist_ok=True)

    ore_config = build()

    out_path = config_dir / "gtceu_ores.json"
    out_path.write_text(
        json.dumps(asdict(ore_config), indent=2),
        encoding="utf-8",
    )
    print(f"\nWrote {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
