# harness/probes/

Standalone diagnostic macros, run **manually from the jsMacros GUI** (or bound to a
key). They are NOT part of the deployed service harness — `sync.py SERVICE_FILES`
does not ship them — and they never touch the bridge/main/worker services.

- `probe_runtime.js` — runtime/API verification probe: checks the runtime assumptions
  the kernel is built on (GraalJS version, ES feature set, jsMacros API surface)
  against the ACTUAL installed runtime. Run it after a modpack/jsMacros update before
  trusting the harness.
- `key-debug.js` — prints every Key event value to chat + file, for discovering
  what `ev.key` contains for a given physical key.

To use one: copy it into the game instance's `config/jsMacros/Macros/` folder (or
any folder jsMacros can see) and run it once from the GUI.
