// MissionRegistry — every mission is registered here at bundle init; the kernel
// activates one at a time via `mission_start <name>`. Adding a mission = one
// registry.register(...) call, no kernel edit.
import type { Mission } from "@/shared/kernel/mission";

export class MissionRegistry {
  private readonly missions = new Map<string, Mission>();

  register(m: Mission): this {
    this.missions.set(m.name, m);
    return this;
  }

  get(name: string): Mission | undefined {
    return this.missions.get(name);
  }

  list(): Mission[] {
    return [...this.missions.values()];
  }

  names(): string[] {
    return [...this.missions.keys()];
  }
}
