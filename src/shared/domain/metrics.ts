// Prometheus-textfile metric registry — pure, jsMacros-free, unit-tested. Holds
// counters (monotonic) + gauges (set each render) and renders them in the exposition
// format node_exporter's textfile collector ingests. The telemetry capability feeds
// it from the event bus + per-tick state; the rendered text is written atomically to
// a *.prom file. Game KPIs, not technical metrics.

import { must } from "@/core/prim/invariant";

type MetricType = "counter" | "gauge";
type Labels = Readonly<Record<string, string>>;

interface Series {
  readonly name: string;
  readonly type: MetricType;
  readonly labels: Labels;
  value: number;
}

// name{label="v",...} — labels sorted so a series has ONE canonical key.
function seriesKey(name: string, labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return name;
  const inner = keys.map((k) => `${k}="${escapeLabel(labels[k] ?? "")}"`).join(",");
  return `${name}{${inner}}`;
}

// Prometheus label-value escaping: backslash, double-quote, newline.
function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

const VALID_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

export class Metrics {
  private readonly series = new Map<string, Series>();

  /** Add to a counter (created at 0 on first touch). */
  inc(name: string, labels: Labels = {}, by = 1): void {
    this.touch("counter", name, labels).value += by;
  }

  /** Set a gauge to an absolute value. */
  setGauge(name: string, value: number, labels: Labels = {}): void {
    this.touch("gauge", name, labels).value = value;
  }

  /** Drop every series whose metric name matches — used to clear a labeled gauge
   *  family (e.g. miner_phase{phase=…}) before setting the single current member, so
   *  no stale series lingers across renders. */
  clear(name: string): void {
    for (const key of [...this.series.keys()]) {
      if (key === name || key.startsWith(`${name}{`)) this.series.delete(key);
    }
  }

  private touch(type: MetricType, name: string, labels: Labels): Series {
    const key = seriesKey(name, labels);
    let s = this.series.get(key);
    if (!s) {
      s = { name, type, labels, value: 0 };
      this.series.set(key, s);
    }
    return s;
  }

  /** Render the exposition text: one `# TYPE` line per metric name, then its series.
   *  `prefix` (e.g. "miner_") is prepended to every metric name. Deterministic ordering
   *  (by name, then series key) so diffs are stable. */
  render(prefix = ""): string {
    const byName = new Map<string, Series[]>();
    for (const s of this.series.values()) {
      const list = byName.get(s.name);
      if (list) list.push(s);
      else byName.set(s.name, [s]);
    }
    const out: string[] = [];
    for (const name of [...byName.keys()].sort()) {
      const full = `${prefix}${name}`;
      if (!VALID_NAME.test(full)) continue; // skip anything that isn't a legal metric name
      const list = must(byName.get(name), "render: name from keys()")
        .slice()
        .sort((a, b) => (seriesKey(a.name, a.labels) < seriesKey(b.name, b.labels) ? -1 : 1));
      out.push(`# TYPE ${full} ${list[0]?.type ?? "untyped"}`);
      for (const s of list) {
        const labelPart = seriesKey(name, s.labels).slice(name.length); // "" or "{...}"
        out.push(`${full}${labelPart} ${s.value}`);
      }
    }
    return `${out.join("\n")}\n`;
  }
}
