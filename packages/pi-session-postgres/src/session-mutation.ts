import type { Entry, LaneRecord, NewRecord, ProvisionedEntry } from "@earendil-works/pi-agent-core";

export type PiSessionMutationOperation =
  | Readonly<{ kind: "create_lane"; lane: string; at: string | null }>
  | Readonly<{ kind: "move_lane"; lane: string; to: string | null }>
  | Readonly<{
      kind: "append_entry";
      entry: ProvisionedEntry<Entry>;
      lane: string;
    }>
  | Readonly<{ kind: "append_record"; record: NewRecord<LaneRecord> }>
  | Readonly<{ kind: "set_name"; name: string }>
  | Readonly<{ kind: "set_label"; id: string; label?: string }>;

export interface PiSessionMutationPublisher {
  mutate(operation: PiSessionMutationOperation): Promise<unknown>;
}
