// The "write your own bot" examples must not name a command the container answers itself.
// main.js dispatches HANDLERS → EXT → worker passthrough, so a module command called `start` or
// `halt` never reaches the module: `ctl send start` answered "already running" (main's
// start-the-worker-service handler), and the standalone sentry example could never be switched on.
//
// The container set is read from the DISPATCH tables themselves, not from the help metadata: a
// handler or ext plugin with no META_COMMANDS row still swallows its name.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { containerSources } from "./_harness-tables";

function containerCommands(): Set<string> {
  const all = new Set<string>();
  for (const names of Object.values(containerSources())) for (const n of names) all.add(n);
  return all;
}

/** The command names an example module handles (`case "x":` in its command()). */
function moduleCommands(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(/case\s+"(\w+)":/g)].map((m) => m[1] ?? "");
}

describe("example bots use command names the container does not own", () => {
  const owned = containerCommands();

  it("each dispatch table is really read (a known command from every source)", () => {
    const src = containerSources();
    for (const c of ["start", "stop", "halt", "status", "goto", "diag"]) {
      expect(src.handlers, `handlers: ${c}`).toContain(c);
    }
    expect(src.screen).toContain("screenshot");
    expect(src.screen).toContain("click");
    expect(src.ext).toContain("prospect");
    expect(src.ext).toContain("emi_search");
    expect(src.bridge).toContain("ping");
    expect(src.bridge).toContain("bridge_diag");
    for (const names of Object.values(src)) expect(names.size).toBeGreaterThan(1);
  });

  // The META-only set missed every ext plugin: none of the 44 has a META_COMMANDS row, yet a module
  // command called `assign` or `sethome` would be answered by ext.js and never reach the module.
  it("ext plugins with no help row are container-owned", () => {
    const { meta } = containerSources();
    for (const c of ["assign", "sethome", "prospect", "markers"]) {
      expect(meta, `${c} has a META row now — pick another ext-only name`).not.toContain(c);
      expect(owned).toContain(c);
    }
  });

  // NEG-CONTROL for the matcher: a name nothing dispatches is not in the set.
  it("a name no layer dispatches is not container-owned", () => {
    expect(owned).not.toContain("sentry_on");
    expect(owned).not.toContain("not_a_command_anywhere");
  });

  for (const file of ["examples/advanced/standalone-bot.ts", "harness/bot_template.js"]) {
    it(`${file}: every command reaches the module`, () => {
      const cmds = moduleCommands(file);
      expect(cmds.length).toBeGreaterThan(0);
      expect(cmds.filter((c) => owned.has(c))).toEqual([]);
    });
  }
});
