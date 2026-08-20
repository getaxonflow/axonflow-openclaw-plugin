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
 * Emitted at most once per process (the latch is module-scoped, so a plugin
 * hot-reload inside the same process does not re-arm it), mirroring the
 * auth-failure breaker in
 * src/axonflow-client.ts (`authFailed` / `authWarningEmitted`): the first
 * unreachable-endpoint call announces the state, and the rest stay quiet
 * rather than printing a line per tool call. `console.warn` is the same
 * channel the auth notice uses, so the message reaches the user's session
 * and not only a plugin log file.
 *
 * A status-401 auth failure does NOT come through here: the client's own
 * one-shot auth notice (`markAuthFailed` in src/axonflow-client.ts) already
 * announces that state. Every OTHER path where a governed tool call proceeds
 * without a policy decision does (#167 network class, #170 auth class under
 * `onError: "allow"`): the invariant is that no governed call ever proceeds
 * ungoverned without a signal.
 */

import { stripControlCharacters } from "./sanitize-text.js";

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
  // This lands in the operator's terminal via console.warn and the cause can
  // carry a remote error body, so control characters go before anything else.
  const collapsed = stripControlCharacters(raw).replace(/\s+/g, " ").trim();
  if (collapsed === "") return "no error detail available";
  return collapsed.length > 200 ? collapsed.slice(0, 200) + "…" : collapsed;
}

/**
 * Announce, once per process, that a governed tool call proceeded without
 * policy evaluation because the governance check failed — the endpoint was
 * unreachable, timed out, answered 5xx, or (#170) rejected the call with an
 * auth-class error under `onError: "allow"` without the client's own 401
 * notice covering it. The wording says "failed" rather than "could not
 * reach" because a 5xx or a 403 WAS reached; the user-visible fact is that
 * nothing was governed.
 *
 * Returns true when this call emitted the notice, false when a previous
 * call already did — so callers can assert the one-shot contract.
 */
export function noteUngovernedFailOpen(endpoint: string, err: unknown): boolean {
  if (noticeEmitted) return false;
  noticeEmitted = true;
  // #171: the endpoint is remote-influenced text on the same footing as the
  // error body. In community-saas mode `resolveRegisteredEndpoint` adopts the
  // endpoint the `POST /api/v1/register` RESPONSE named, and that string is
  // exactly what the caller passes in here. Trim alone leaves ESC/BEL intact,
  // so a hostile registrar could clear the screen and replace this warning
  // with a fabricated "governance active" line - the one surface whose entire
  // job is to say governance is OFF. Strip control characters first, same as
  // `describeCause` does for the error.
  const cleaned = stripControlCharacters(endpoint ?? "").trim();
  const target = cleaned !== "" ? cleaned : "(no endpoint configured)";
  // The caller is inside the catch block whose entire job is to let the tool
  // call through. A host that replaces console.warn with something that
  // throws must not turn this notice into a rejected before_tool_call hook —
  // that would convert the fail-open into a hard failure.
  try {
    console.warn(
      `[AxonFlow] Governance check against ${target} failed (${describeCause(err)}). ` +
        "This tool call ran UNGOVERNED — no policy was evaluated, nothing was blocked, " +
        "and no decision was recorded. Tool calls continue to run ungoverned until the " +
        "governance check succeeds again; restore the endpoint (or fix the credentials " +
        "it rejected) to resume enforcement. " +
        "Shown once per process.",
    );
  } catch {
    // Nowhere left to report it. Never propagate.
  }
  return true;
}

/** Test-only latch reset. Production code never calls this. */
export function resetFailOpenNoticeForTests(): void {
  noticeEmitted = false;
}
