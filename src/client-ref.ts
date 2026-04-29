/**
 * Mutable holder for the AxonFlowClient instance used by hook handlers.
 *
 * Hook factories close over the holder rather than the client value directly.
 * That lets `registerAxonFlowGovernance` swap in a freshly-credentialled
 * client after the asynchronous Community-SaaS bootstrap completes — every
 * already-registered hook reads through `clientRef.current` and immediately
 * sees the new credentials.
 *
 * Without this indirection the bootstrap reassignment is dead code: the
 * handlers were called with the original empty-credential client when they
 * were registered, and JavaScript captured that value by binding, not by
 * reference to the outer `let client` slot.
 */

import type { AxonFlowClient } from "./axonflow-client.js";

export interface ClientRef {
  current: AxonFlowClient;
}
