#!/usr/bin/env python3
"""srg.py — local Mojang-name ↔ Forge SRG-name resolver for Minecraft 1.20.1.

At runtime this Forge modpack (Monifactory) uses **Mojang class names** but **SRG
method/field names** (e.g. `LocalPlayer.respawn()` is called as `m_7583_`,
`Options.keyUse` as `f_92095_`). When driving raw vanilla/Forge internals over the
bridge (`jeval`, the facade's raw `getRaw().m_…_()` calls) you need the SRG name —
and guessing it in-game is slow AND dangerous (blind method-trial tripped the
EventLockWatchdog once). This resolves it OFFLINE from the mapping files the
launcher already extracted to disk — no in-game calls, no network.

It composes two files keyed on the shared obfuscated (`fiy`, `a`) namespace:
  1. Mojang ProGuard client mappings  — Mojang class+member  → obf short name
  2. MCPConfig merged TSRG2 mappings   — obf class+short      → SRG name (m_…/f_…)
The merged file carries the Mojang CLASS name on its class lines, so classes are
keyed by their real names; only MEMBER names need the obf bridge.

Usage:
  srg.py LocalPlayer respawn            # Mojang member → SRG  (m_7583_)
  srg.py Options keyUse                  # field           → SRG  (f_92095_)
  srg.py ItemStack finishUsingItem       # overloads → all SRG candidates + descriptors
  srg.py --rev m_7583_                   # SRG → Mojang class.member
  srg.py --class LocalPlayer             # full Mojang↔SRG table for the class
  srg.py --class LocalPlayer respawn     # filter the table by member-name substring
  srg.py --export srg2mojang.json        # compact SRG→Mojang map (for the reflect ext)
  srg.py --build                         # (re)build the on-disk index cache

Class arg matches by simple name or FQCN suffix (case-insensitive); ambiguous
matches are listed. Add --json for machine-readable output.

If a ParchmentMC export is present (mappings/parchment-*.json — keyed by Mojang
class + Mojang method descriptor), method lookups are enriched with **parameter
names** and **javadoc** (e.g. `clicked(int slotId, int button, …)` + a one-line
summary). Parchment for 1.20.1 is final at release 2023.09.03 (1.20.1 itself froze
in 2023 — the data isn't stale, it's complete for this MC version). Download once:
  curl -L -o mappings/parchment-1.20.1-2023.09.03.json \\
    <(unzip -p <(curl -sL https://maven.parchmentmc.org/org/parchmentmc/data/\\
parchment-1.20.1/2023.09.03/parchment-1.20.1-2023.09.03.zip) parchment.json)

Mapping locations are resolved under the launcher `libraries/` dir (a sibling of the
`instances/` dir local_config.py finds — see MC_INSTANCES_ROOT / local.config.json);
override individual mapping files with --proguard / --merged / --parchment.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # scripts/ root
import local_config  # noqa: E402

VERSION = os.environ.get("MC_MAPPINGS_VERSION", "1.20.1-20230612.114412")
# The launcher's `libraries/` dir is a sibling of its `instances/` dir (both live
# directly under e.g. ~/.local/share/FreesmLauncher/). Resolved via local_config's
# usual precedence: MC_INSTANCES_ROOT env > local.config.json > autodetect. Resolved on use,
# not at import, so `--help` works on a machine with no launcher yet.


def _default_mappings() -> tuple[Path, Path]:
    """(ProGuard, merged TSRG2) mappings under the launcher's `libraries/` dir."""
    libs = local_config.instances_root().parent / "libraries"
    return (libs / f"net/minecraft/client/{VERSION}/client-{VERSION}-mappings.txt",
            libs / f"de/oceanlabs/mcp/mcp_config/{VERSION}/mcp_config-{VERSION}-mappings-merged.txt")


# Cache lives in the repo (gitignored) so the ~13MB parse runs once.
MAPPINGS_ROOT = Path(__file__).resolve().parents[2] / "mappings"  # repo root (this file lives in scripts/dev/)
CACHE_DIR = MAPPINGS_ROOT / VERSION
CACHE = CACHE_DIR / "index.json"


def _default_parchment() -> Path | None:
    """Newest mappings/parchment-*.json (the ParchmentMC export), if downloaded."""
    found = sorted(MAPPINGS_ROOT.glob("parchment-*.json"))
    return found[-1] if found else None

# A JVM primitive/array descriptor map for Mojang source types (overload disambig).
PRIM = {
    "void": "V", "boolean": "Z", "byte": "B", "char": "C", "short": "S",
    "int": "I", "long": "J", "float": "F", "double": "D",
}


def _type_to_desc(t: str, moj2obf: dict[str, str]) -> str:
    """Mojang source type (e.g. 'net.minecraft.world.level.Level', 'int[]') → JVM
    descriptor in the OBF namespace, so it can be matched against the merged file."""
    arr = ""
    while t.endswith("[]"):
        arr += "["
        t = t[:-2]
    if t in PRIM:
        return arr + PRIM[t]
    obf = moj2obf.get(t)
    # Unmapped (a non-MC type, or already obf) → use the obf class if known, else the
    # raw name slashed. Matching only needs consistency for the disambiguation pass.
    cls = obf if obf else t
    return arr + "L" + cls.replace(".", "/") + ";"


def _args_desc(arg_types: list[str], moj2obf: dict[str, str]) -> str:
    return "(" + "".join(_type_to_desc(a, moj2obf) for a in arg_types if a) + ")"


def _args_desc_moj(arg_types: list[str]) -> str:
    """Args portion of a JVM descriptor in the MOJANG namespace (slashed Mojang class
    names) — for matching ProGuard overloads against Parchment, which keys methods by
    their Mojang descriptor (e.g. '(Lnet/minecraft/world/item/ItemStack;)V')."""
    out = []
    for t in arg_types:
        if not t:
            continue
        arr = ""
        while t.endswith("[]"):
            arr += "["
            t = t[:-2]
        out.append(arr + (PRIM[t] if t in PRIM else "L" + t.replace(".", "/") + ";"))
    return "(" + "".join(out) + ")"


def _parse_parchment(path: Path):
    """ParchmentMC export (parchment.json): per Mojang class, methods carry parameter
    names + javadoc, keyed by Mojang name + descriptor. Returns
    methods[moj_class_dotted][(name, args_desc)] = {'params': [...], 'jd': [...]} and
    fields[moj_class_dotted][name] = [jd...]. args_desc = the '(...)' portion only, so
    it matches `_args_desc_moj` (return type is ignored for overload disambiguation)."""
    d = json.loads(path.read_text(encoding="utf-8"))

    def walk(node):
        yield from node.get("classes", [])
        for p in node.get("packages", []):
            yield from walk(p)

    methods: dict[str, dict] = {}
    fields: dict[str, dict] = {}
    for c in walk(d):
        cls = c["name"].replace("/", ".")
        mm = methods.setdefault(cls, {})
        for m in c.get("methods", []):
            desc = m.get("descriptor", "") or ""
            args = desc[: desc.index(")") + 1] if ")" in desc else desc
            pnames = [p["name"] for p in (m.get("parameters") or []) if p.get("name")]
            jd = m.get("javadoc")
            if pnames or jd:
                mm[(m["name"], args)] = {"params": pnames, "jd": jd}
        ff = fields.setdefault(cls, {})
        for f in c.get("fields", []):
            if f.get("javadoc"):
                ff[f["name"]] = f["javadoc"]
    return methods, fields


def _parse_proguard(path: Path):
    """ProGuard: '<mojfqcn> -> <obf>:' then indented '<ret> <name>(<args>) -> <short>'
    (methods, optional 'start:end:' prefix) and '<type> <name> -> <short>' (fields)."""
    moj2obf_class: dict[str, str] = {}
    # per mojang class: methods {name: [(arg_types, obf_short)]}, fields {name: obf_short}
    methods: dict[str, dict[str, list]] = {}
    fields: dict[str, dict[str, str]] = {}
    cur = None
    cls_re = re.compile(r"^(\S.+?) -> (\S+):$")
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if not line or line.startswith("#"):
                continue
            if not line[0].isspace():
                m = cls_re.match(line)
                if m:
                    cur = m.group(1)
                    moj2obf_class[cur] = m.group(2)
                    methods[cur] = {}
                    fields[cur] = {}
                continue
            if cur is None:
                continue
            body = line.strip()
            if " -> " not in body:
                continue
            left, short = body.rsplit(" -> ", 1)
            # strip line-number prefix on methods: '12:13:void foo(...)'
            left = re.sub(r"^\d+:\d+:", "", left)
            if "(" in left:  # method
                sig, args = left.split("(", 1)
                args = args.rstrip(")")
                name = sig.split()[-1]
                arg_types = [a.strip() for a in args.split(",")] if args.strip() else []
                methods[cur].setdefault(name, []).append((arg_types, short))
            else:  # field: '<type> <name>'
                parts = left.split()
                if len(parts) >= 2:
                    fields[cur][parts[-1]] = short
    return moj2obf_class, methods, fields


def _parse_merged(path: Path):
    """Merged TSRG2: class line '<obf> <moj/slashed>'; member lines (tab-indented)
    '<short> <srg>' (field) or '<short> <obfdesc> <srg>' (method)."""
    obf2moj_class: dict[str, str] = {}
    # per obf class: methods {short: [(obfdesc, srg)]}, fields {short: srg}
    methods: dict[str, dict[str, list]] = {}
    fields: dict[str, dict[str, str]] = {}
    cur = None
    with path.open(encoding="utf-8") as fh:
        first = fh.readline()
        if not first.startswith("tsrg2"):
            fh.seek(0)
        for line in fh:
            line = line.rstrip("\n")
            if not line:
                continue
            if not line[0].isspace():
                parts = line.split()
                if len(parts) >= 2:
                    cur = parts[0]
                    obf2moj_class[cur] = parts[1].replace("/", ".")
                    methods[cur] = {}
                    fields[cur] = {}
                continue
            if cur is None:
                continue
            parts = line.split()
            if len(parts) == 2:  # field: short srg
                fields[cur][parts[0]] = parts[1]
            elif len(parts) >= 3:  # method: short desc srg
                methods[cur].setdefault(parts[0], []).append((parts[1], parts[2]))
    return obf2moj_class, methods, fields


def build_index(proguard: Path, merged: Path, parchment: Path | None = None) -> dict:
    if not proguard.exists():
        sys.exit(f"srg.py: ProGuard mappings not found: {proguard}\n  (set --proguard or MC_MAPPINGS_DIR)")
    if not merged.exists():
        sys.exit(f"srg.py: merged TSRG2 mappings not found: {merged}\n  (set --merged)")
    moj2obf_class, pg_methods, pg_fields = _parse_proguard(proguard)
    obf2moj_class, mg_methods, mg_fields = _parse_merged(merged)
    # Parchment is optional: param names + javadoc keyed by Mojang class + descriptor.
    parch_m: dict[str, dict] = {}
    parch_f: dict[str, dict] = {}
    if parchment and parchment.exists():
        parch_m, parch_f = _parse_parchment(parchment)

    # Per Mojang class, resolve every member to its SRG name by bridging on obf.
    classes: dict[str, dict] = {}
    rev: dict[str, list[str]] = {}  # srg → ["Class.member", ...]
    for moj_cls, obf_cls in moj2obf_class.items():
        mg_m = mg_methods.get(obf_cls, {})
        mg_f = mg_fields.get(obf_cls, {})
        pm = parch_m.get(moj_cls, {})
        pf = parch_f.get(moj_cls, {})
        out_methods: dict[str, list] = {}
        out_fields: dict[str, str] = {}
        for name, variants in pg_methods.get(moj_cls, {}).items():
            for arg_types, short in variants:
                cands = mg_m.get(short)
                if not cands:
                    continue
                if len(cands) == 1:
                    srg = cands[0][1]
                else:  # overloaded obf short → match by descriptor
                    want = _args_desc(arg_types, moj2obf_class)
                    srg = next(
                        (s for d, s in cands if d.startswith(want)),
                        cands[0][1],  # fall back to first if remap missed
                    )
                entry = {"srg": srg, "args": arg_types}
                # Attach Parchment param names + javadoc, matched by Mojang descriptor.
                pinfo = pm.get((name, _args_desc_moj(arg_types)))
                if pinfo:
                    if pinfo["params"]:
                        entry["params"] = pinfo["params"]
                    if pinfo["jd"]:
                        entry["jd"] = pinfo["jd"]
                out_methods.setdefault(name, []).append(entry)
                rev.setdefault(srg, []).append(f"{moj_cls}#{name}()")
        for name, short in pg_fields.get(moj_cls, {}).items():
            srg = mg_f.get(short)
            if srg:
                fe: dict = {"srg": srg}
                if name in pf:
                    fe["jd"] = pf[name]
                out_fields[name] = fe
                rev.setdefault(srg, []).append(f"{moj_cls}#{name}")
        if out_methods or out_fields:
            classes[moj_cls] = {"methods": out_methods, "fields": out_fields}
    return {"version": VERSION, "classes": classes, "rev": rev,
            "parchment": bool(parch_m)}


def load_index(args) -> dict:
    if args.proguard and args.merged:
        pg, mg = Path(args.proguard), Path(args.merged)
    else:
        default_pg, default_mg = _default_mappings()
        pg = Path(args.proguard) if args.proguard else default_pg
        mg = Path(args.merged) if args.merged else default_mg
    pc = Path(args.parchment) if args.parchment else _default_parchment()
    srcs = [p for p in (pg, mg, pc) if p]
    if CACHE.exists() and not args.rebuild:
        # Rebuild if a source file is newer than the cache (Parchment included, so
        # downloading it later refreshes the index automatically).
        cm = CACHE.stat().st_mtime
        if all(not p.exists() or p.stat().st_mtime <= cm for p in srcs):
            return json.loads(CACHE.read_text())
    idx = build_index(pg, mg, pc)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(idx))
    return idx


def _match_classes(idx: dict, query: str) -> list[str]:
    q = query.replace("/", ".")
    ql = q.lower()
    names = list(idx["classes"].keys())
    exact = [n for n in names if n.lower() == ql]
    if exact:
        return exact
    suffix = [n for n in names if n.lower().endswith("." + ql) or n.lower().rsplit("$", 1)[-1] == ql]
    if suffix:
        return suffix
    return [n for n in names if ql in n.lower()]


def _fmt_sig(v: dict) -> str:
    """Render a method's arg list: 'type name' pairs when Parchment param names are
    present (and counts line up), else just the types."""
    args = v.get("args", [])
    params = v.get("params")
    if params and len(params) == len(args):
        return ", ".join(f"{t} {n}" for t, n in zip(args, params))
    if params:
        return ", ".join(params)
    return ", ".join(args)


def _jd(v: dict, width: int = 100) -> str:
    """One-line javadoc summary (joined + truncated) from Parchment, or ''."""
    jd = v.get("jd")
    if not jd:
        return ""
    text = " ".join(s.strip() for s in jd if s).strip()
    return text if len(text) <= width else text[: width - 1] + "…"


def cmd_lookup(idx: dict, cls_q: str, member: str, as_json: bool) -> int:
    matches = _match_classes(idx, cls_q)
    if not matches:
        print(f"no class matching '{cls_q}'", file=sys.stderr)
        return 1
    if len(matches) > 1 and not any(m.rsplit(".", 1)[-1].lower() == cls_q.lower() for m in matches):
        print(f"ambiguous class '{cls_q}' — matches:\n  " + "\n  ".join(sorted(matches)[:20]), file=sys.stderr)
        return 1
    results = []
    for cls in matches:
        c = idx["classes"][cls]
        if member in c["fields"]:
            fe = c["fields"][member]
            results.append({"class": cls, "member": member, "kind": "field",
                            "srg": fe["srg"], "jd": fe.get("jd")})
        for v in c["methods"].get(member, []):
            results.append({"class": cls, "member": member, "kind": "method", **v})
    if not results:
        # Not declared on this class — it may be inherited from a superclass. The
        # ProGuard file lists each member under its DECLARING class, so scan globally
        # and point at where it actually lives (handles getMainHandItem on LivingEntity).
        elsewhere = []
        for cn, c in idx["classes"].items():
            if member in c["fields"]:
                elsewhere.append(f"{c['fields'][member]['srg']}\t# field {cn}.{member}")
            for v in c["methods"].get(member, []):
                elsewhere.append(f"{v['srg']}\t# {cn}.{member}({_fmt_sig(v)})")
        if elsewhere:
            print(f"'{member}' is not declared on {matches[0]} (likely inherited). "
                  f"Declared on:", file=sys.stderr)
            print("\n".join(sorted(set(elsewhere))))
            return 0
        print(f"no member '{member}' in {matches[0]} (or any class)", file=sys.stderr)
        return 1
    if as_json:
        print(json.dumps(results, indent=2))
    else:
        for r in results:
            if r["kind"] == "field":
                print(f"{r['srg']}\t# field {r['class']}.{r['member']}")
            else:
                print(f"{r['srg']}\t# {r['class']}.{r['member']}({_fmt_sig(r)})")
            doc = _jd(r)
            if doc:
                print(f"\t    ↪ {doc}")
    return 0


def cmd_rev(idx: dict, srg: str, as_json: bool) -> int:
    hits = idx["rev"].get(srg)
    if not hits:
        print(f"no Mojang name for SRG '{srg}'", file=sys.stderr)
        return 1
    if as_json:
        print(json.dumps(hits, indent=2))
    else:
        for h in hits:
            print(h)
    return 0


def cmd_class(idx: dict, cls_q: str, filt: str | None, as_json: bool) -> int:
    matches = _match_classes(idx, cls_q)
    if not matches:
        print(f"no class matching '{cls_q}'", file=sys.stderr)
        return 1
    cls = sorted(matches, key=len)[0]
    c = idx["classes"][cls]
    fl = filt.lower() if filt else None
    table = {"class": cls, "fields": {}, "methods": {}}
    for n, fe in sorted(c["fields"].items()):
        if not fl or fl in n.lower():
            table["fields"][n] = fe
    for n, vs in sorted(c["methods"].items()):
        if not fl or fl in n.lower():
            table["methods"][n] = vs
    if as_json:
        print(json.dumps(table, indent=2))
        return 0
    print(f"# {cls}")
    for n, fe in table["fields"].items():
        print(f"{fe['srg']}\tfield {n}")
    for n, vs in table["methods"].items():
        for v in vs:
            print(f"{v['srg']}\t{n}({_fmt_sig(v)})")
            doc = _jd(v)
            if doc:
                print(f"\t    ↪ {doc}")
    return 0


def cmd_remap(idx: dict, directory: str) -> int:
    """Rewrite SRG member tokens (m_NNNNN_ / f_NNNNN_) to Mojang names across every .java
    under `directory`. SRG names are GLOBALLY UNIQUE, so a plain token replace is correct —
    this turns decompiled SRG source (`this.f_108617_.m_104955_(...)`) into readable Mojang
    source (`this.connection.send(...)`). Member names only; local vars (var1) need Parchment."""
    # srg → simple Mojang member name (strip "Class#" and "()").
    names: dict[str, str] = {}
    for srg, hits in idx["rev"].items():
        v = hits[0]
        n = v.split("#", 1)[1] if "#" in v else v
        names[srg] = n.split("(", 1)[0]
    tok = re.compile(r"\b([mf]_\d+_)\b")
    root = Path(directory)
    files = list(root.rglob("*.java")) if root.is_dir() else [root]
    total_files, total_repl = 0, 0
    for f in files:
        text = f.read_text(encoding="utf-8", errors="replace")
        count = [0]

        def sub(m):
            name = names.get(m.group(1))
            if name:
                count[0] += 1
                return name
            return m.group(1)

        new = tok.sub(sub, text)
        if count[0]:
            f.write_text(new, encoding="utf-8")
            total_files += 1
            total_repl += count[0]
    print(f"remapped {total_repl} SRG tokens across {total_files} file(s) under {directory}")
    return 0


def cmd_export(idx: dict, out: str) -> int:
    # Flat SRG → "Class#member(paramNames)" for annotating live reflect output. Built
    # from the enriched class table so Parchment param names ride along (reflect shows
    # runtime TYPES + these NAMES, e.g. `m_150399_(int,int,…) →clicked(slotId, button…)`).
    # First occurrence wins (member-level annotation is enough).
    flat: dict[str, str] = {}
    for cls, c in idx["classes"].items():
        for name, vs in c["methods"].items():
            for v in vs:
                if v["srg"] in flat:
                    continue
                ps = ", ".join(v["params"]) if v.get("params") else ""
                flat[v["srg"]] = f"{cls}#{name}({ps})"
        for name, fe in c["fields"].items():
            flat.setdefault(fe["srg"], f"{cls}#{name}")
    Path(out).write_text(json.dumps(flat))
    print(f"wrote {len(flat)} SRG→Mojang entries to {out}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Mojang↔SRG name resolver (1.20.1 Forge)")
    ap.add_argument("klass", nargs="?", help="class (simple name / FQCN suffix)")
    ap.add_argument("member", nargs="?", help="Mojang member name (or filter with --class)")
    ap.add_argument("--rev", metavar="SRG", help="reverse: SRG name → Mojang class.member")
    ap.add_argument("--class", dest="class_mode", action="store_true", help="dump the class's full table")
    ap.add_argument("--export", metavar="OUT", help="write flat SRG→Mojang JSON")
    ap.add_argument("--remap", metavar="DIR", help="rewrite m_…/f_… tokens → Mojang names in .java under DIR")
    ap.add_argument("--build", "--rebuild", dest="rebuild", action="store_true", help="(re)build the index cache")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--proguard", help="override ProGuard mappings path")
    ap.add_argument("--merged", help="override merged TSRG2 mappings path")
    ap.add_argument("--parchment", help="override ParchmentMC export path (param names + javadoc)")
    args = ap.parse_args()

    idx = load_index(args)
    if args.rebuild and not (args.rev or args.export or args.klass):
        parch = " +parchment" if idx.get("parchment") else " (no parchment)"
        print(f"index built: {len(idx['classes'])} classes, {len(idx['rev'])} SRG names{parch} → {CACHE}")
        return 0
    if args.rev:
        return cmd_rev(idx, args.rev, args.json)
    if args.export:
        return cmd_export(idx, args.export)
    if args.remap:
        return cmd_remap(idx, args.remap)
    if args.class_mode:
        if not args.klass:
            ap.error("--class needs a class name")
        return cmd_class(idx, args.klass, args.member, args.json)
    if args.klass and args.member:
        return cmd_lookup(idx, args.klass, args.member, args.json)
    ap.error("give: <Class> <member>  |  --rev <SRG>  |  --class <Class>  |  --export <out>")
    return 2


if __name__ == "__main__":
    sys.exit(main())
