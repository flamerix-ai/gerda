// Example: a minimal ext.js plugin — the hot-reload path for new bridge commands.
//
// ext.js (harness/ext.js) is the reloadable mod-API layer: each plugin
// self-registers a bridge command, and the whole file re-evals via the
// `reload_ext` command — no main.js restart, no game restart. The iteration
// loop is:  edit → `./gerda sync` → `reload_ext`  (seconds, in a live game).
//
// To try this one: paste the block below into the IIFE in harness/ext.js,
// sync + reload_ext, then:
//   python3 scripts/ops/bridge_ctl.py send whereami
//
// Plugins run with full jsMacros scope (the globals below are injected by
// main.js): Java, World, Player, Hud, Chat, Client, KeyBind, JavaWrapper,
// plus writeResp (send the reply) and register (add the command).
//
// Rules of the layer (docs/EXTENDING.md):
//   - one plugin = one register() call; keep helpers inside the IIFE so a
//     re-eval replaces them cleanly (the registry is reset, not additive).
//   - reply via writeResp(id, {...}) exactly once — the bridge correlates acks.
//   - annotate any SRG/reflection trick with how it was derived (srg.py /
//     reflect) so the next reader can re-derive it after a game update.

register(
  "whereami",
  (_req, id) => {
    const p = Player.getPlayer();
    if (p === null) {
      writeResp(id, { ok: false, error: "not in a world" });
      return;
    }
    const pos = p.getPos();
    writeResp(id, {
      ok: true,
      x: Math.floor(pos.getX()),
      y: Math.floor(pos.getY()),
      z: Math.floor(pos.getZ()),
      dimension: World.getDimension(),
      biome: World.getBiomeAt(Math.floor(pos.getX()), Math.floor(pos.getZ())),
    });
  },
  { desc: "current position + dimension + biome", params: {} },
);
