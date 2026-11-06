// IO facet of the jsMacros runtime — chat output + filesystem + HTTP. Grouped as the host-side
// side channels (nothing touches the player/world). Part of the exempt globals group.
import type { Runtime } from "@/core/runtime/Runtime";
import type { Fx } from "@/core/runtime/jsmacros/shared";
import type { Result } from "@/core/runtime/types";

export function ioFacet(fx: Fx): Pick<Runtime, "chat" | "fs" | "http"> {
  const { attempt, fx: fxDo } = fx;
  return {
    chat: {
      say: (text: string) => fxDo("say", () => Chat.say(text)),
      log: (text: string) => {
        // System.out is captured into latest.log; Chat.log only hits the HUD.
        fxDo("logStdout", () => java.lang.System.out.println(`[Miner] ${text}`));
        fxDo("logChat", () => Chat.log(text));
      },
    },

    fs: {
      appendLine(path: string, line: string): void {
        // The log sink itself — can't report its own failure without recursing.
        fxDo("appendLine", () => {
          const FileWriter = Java.type("java.io.FileWriter");
          const BufferedWriter = Java.type("java.io.BufferedWriter");
          const w = new BufferedWriter(new FileWriter(path, true));
          try {
            w.write(line);
            w.newLine();
          } finally {
            w.close();
          }
        });
      },
      write(path: string, data: string): Result<void> {
        return attempt(() => {
          const Files = Java.type("java.nio.file.Files");
          const Paths = Java.type("java.nio.file.Paths");
          const SC = Java.type("java.nio.charset.StandardCharsets");
          const p = Paths.get(path);
          // Create parent dirs so callers (e.g. the JourneyMap mirror writing into a
          // possibly-absent waypoints/ dir) don't have to — a plain FileWriter throws on
          // a missing directory.
          const parent = p.getParent();
          if (parent) Files.createDirectories(parent);
          Files.writeString(p, data, SC.UTF_8);
        });
      },
      read(path: string): Result<string | null> {
        return attempt(() => {
          const Files = Java.type("java.nio.file.Files");
          const Paths = Java.type("java.nio.file.Paths");
          const SC = Java.type("java.nio.charset.StandardCharsets");
          const p = Paths.get(path);
          if (!Files.exists(p)) return null;
          // SC.UTF_8 (the Charset instance), NOT SC (the class) — readString(Path,Charset)
          // has no overload taking a Class, so passing SC throws "no applicable overload".
          return Files.readString(p, SC.UTF_8).toString();
        });
      },
      writeAtomic(path: string, data: string): Result<void> {
        // Stage to <path>.tmp then ATOMIC_MOVE over the target, so node_exporter's
        // textfile collector never scrapes a partially-written .prom.
        return attempt(() => {
          const Files = Java.type("java.nio.file.Files");
          const Paths = Java.type("java.nio.file.Paths");
          const SC = Java.type("java.nio.charset.StandardCharsets");
          const StandardCopyOption = Java.type("java.nio.file.StandardCopyOption");
          const tmp = Paths.get(`${path}.tmp`);
          const dst = Paths.get(path);
          Files.writeString(tmp, data, SC.UTF_8);
          Files.move(tmp, dst, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        });
      },
    },

    http: {
      post(url: string, body: string, contentType: string): Result<void> {
        // Blocking HttpURLConnection on the worker-service thread (NOT the render
        // thread) with tight timeouts — a 2 s localhost POST to VictoriaMetrics.
        return attempt(() => {
          const URL = Java.type("java.net.URL");
          const SC = Java.type("java.nio.charset.StandardCharsets");
          const OutputStreamWriter = Java.type("java.io.OutputStreamWriter");
          const conn = new URL(url).openConnection();
          conn.setRequestMethod("POST");
          conn.setDoOutput(true);
          conn.setConnectTimeout(2000);
          conn.setReadTimeout(2000);
          conn.setRequestProperty("Content-Type", contentType);
          const out = conn.getOutputStream();
          try {
            // GraalJS `new java.lang.String(jsString)` yields a JS string with no
            // .getBytes — wrap the stream in a charset writer and write the body directly.
            const w = new OutputStreamWriter(out, SC.UTF_8);
            w.write(body);
            w.flush();
          } finally {
            out.close();
          }
          const code = conn.getResponseCode();
          conn.disconnect();
          if (code < 200 || code >= 300) throw new Error(`HTTP ${code}`);
        });
      },
    },
  };
}
