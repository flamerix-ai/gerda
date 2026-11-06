// Shared dump blackboard slice. The inventory guard queues a dump trip; the
// home/return + storage handlers consume and clear it. Kept separate from the
// mining slice so the field-resume state (MiningMem.origin + spiral cache) stays
// untouched across a HOME→DUMP→RETURN round trip.
import { defineSlice } from "@/shared/kernel/slice";

interface DumpMem {
  pending: boolean;
  reason: string;
}

function initDumpMem(): DumpMem {
  return { pending: false, reason: "" };
}

export const DUMP_SLICE = defineSlice("dump", initDumpMem);
