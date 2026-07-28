/**
 * One-shot notice for the network-error fail-open path.
 *
 * `before_tool_call` allows a tool through when the governance check cannot
 * reach the endpoint (timeout, DNS failure, connection refused, 5xx). That
 * policy is deliberate — a transient AxonFlow outage must not wedge every
 * tool in the user's session — and this module does not change it.
 *
 * What it changes is the silence. Through v2.8.4 a plugin pointed at an
 * unreachable endpoint went on executing governed tools with no policy
 * evaluation and no signal of any kind, so a session could run entirely
 * ungoverned while the user believed governance was on (#167). A governance
 * plugin that has stopped governing has to say so.
 *
 * Emitted at most once per process, mirroring the auth-failure breaker in
 * src/axonflow-client.ts (`authFailed` / `authWarningEmitted`): the first
 * unreachable-endpoint call announces the state, and the rest stay quiet
 * rather than printing a line per tool call. `console.warn` is the same
 * channel the auth notice uses, so the message reaches the user's session
 * and not only a plugin log file.
 *
 * Auth failures do NOT come through here — those already respect
 * `config.onError` and carry their own one-shot notice.
 */

/** Process-lifetime latch. Reset only by {@link resetFailOpenNoticeForTests}. */
let noticeEmitted = false;

/**
 * Truncate a thrown error's description to a bounded, single-line form.
 * Network errors are short ("fetch failed", "The operation was aborted"),
 * but a 5xx body or a proxy error can be arbitrarily long, and this string
 * lands in the user's terminal.
 */
function describeCause(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed === "") return "no error detail available";
  return collapsed.length > 200 ? collapsed.slice(0, 200) + "…" : collapsed;
}

/**
 * Announce, once per process, that a governed tool call proceeded without
 * policy evaluation because the AxonFlow endpoint was unreachable.
 *
 * Returns true when this call emitted the notice, false when a previous
 * call already did — so callers can assert the one-shot contract.
 */
export function noteNetworkFailOpen(endpoint: string, err: unknown): boolean {
  if (noticeEmitted) return false;
  noticeEmitted = true;
  const target = endpoint && endpoint.trim() !== "" ? endpoint.trim() : "(no endpoint configured)";
  console.warn(
    `[AxonFlow] Could not reach ${target} (${describeCause(err)}). ` +
      "This tool call ran UNGOVERNED — no policy was evaluated, nothing was blocked, " +
      "and no decision was recorded. Tool calls continue to run ungoverned while the " +
      "endpoint is unreachable; restore connectivity to resume enforcement. " +
      "Shown once per session.",
  );
  return true;
}

/** Test-only latch reset. Production code never calls this. */
export function resetFailOpenNoticeForTests(): void {
  noticeEmitted = false;
}
