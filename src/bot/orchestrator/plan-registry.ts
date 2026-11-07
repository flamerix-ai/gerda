// PlanRegistry — every plan is registered here at bundle init; the orchestrator
// activates one at a time via `plan_start <name>`. Mirrors MissionRegistry.
import type { Plan } from "@/bot/orchestrator/plan";

export class PlanRegistry {
  private readonly plans = new Map<string, Plan>();

  register(p: Plan): this {
    this.plans.set(p.name, p);
    return this;
  }

  get(name: string): Plan | undefined {
    return this.plans.get(name);
  }

  list(): Plan[] {
    return [...this.plans.values()];
  }

  names(): string[] {
    return [...this.plans.keys()];
  }
}
