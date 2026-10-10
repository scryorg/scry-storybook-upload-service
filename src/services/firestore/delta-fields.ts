// sync-delta-upload: the delta marker and deadline on a Build, as plain values (shared by the Worker and Node Firestore services).
import type { Build } from './firestore.types.js';

export function deltaBuildFields(data: { delta?: boolean; deltaDeadline?: Date }): Pick<Build, 'delta' | 'deltaDeadline'> {
  return {
    ...(data.delta ? { delta: true as const } : {}),
    ...(data.deltaDeadline ? { deltaDeadline: data.deltaDeadline } : {}),
  };
}
