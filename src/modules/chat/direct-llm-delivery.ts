export type DirectLlmDeliveryGate = {
  accepting: boolean;
  pendingWrites: number;
  waiters: Set<() => void>;
};

const gates = new Map<string, DirectLlmDeliveryGate>();

/** Open the admission boundary owned by one concrete DirectLLM run. */
export function openDirectLlmDeliveryGate(
  conversationId: string,
): DirectLlmDeliveryGate {
  const gate: DirectLlmDeliveryGate = {
    accepting: true,
    pendingWrites: 0,
    waiters: new Set(),
  };
  gates.set(conversationId, gate);
  return gate;
}

/**
 * Reserve one transcript mutation against the active DirectLLM run. The
 * returned release function must be called after direct_user_pending is
 * durable. A missing claim means the message remains browser-owned.
 */
export function claimDirectLlmDelivery(
  conversationId: string,
): (() => void) | undefined {
  const gate = gates.get(conversationId);
  if (!gate?.accepting) return undefined;
  gate.pendingWrites++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    gate.pendingWrites--;
    if (gate.pendingWrites === 0) {
      for (const resolve of gate.waiters) resolve();
      gate.waiters.clear();
    }
  };
}

/** Stop admission and wait until every already-admitted write is durable. */
export async function closeDirectLlmDeliveryGate(
  conversationId: string,
  gate: DirectLlmDeliveryGate,
): Promise<void> {
  if (gates.get(conversationId) !== gate) return;
  gate.accepting = false;
  if (gate.pendingWrites === 0) return;
  await new Promise<void>((resolve) => gate.waiters.add(resolve));
}

/** Close whichever DirectLLM run currently owns this conversation. */
export async function closeActiveDirectLlmDeliveryGate(
  conversationId: string,
): Promise<DirectLlmDeliveryGate | undefined> {
  const gate = gates.get(conversationId);
  if (gate) await closeDirectLlmDeliveryGate(conversationId, gate);
  return gate;
}

/** Remove a run's closed gate without disturbing a newer run. */
export function deleteDirectLlmDeliveryGate(
  conversationId: string,
  gate: DirectLlmDeliveryGate,
): void {
  if (gates.get(conversationId) === gate) gates.delete(conversationId);
}

export function hasOpenDirectLlmDeliveryGate(conversationId: string): boolean {
  return gates.get(conversationId)?.accepting === true;
}
