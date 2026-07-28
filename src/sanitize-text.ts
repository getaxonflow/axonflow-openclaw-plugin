/**
 * Neutralise terminal control sequences in remote text.
 *
 * Since #167 the plugin renders server-supplied error bodies into three
 * surfaces that all reach a person or a model: `console.warn` (the operator's
 * terminal), the `blockReason` OpenClaw shows the user and feeds back to the
 * model, and the `details` payload of an agent tool result. Before that change
 * none of those carried response-body text at all.
 *
 * The body is attacker-controlled — the same premise the credential-echo
 * redaction rests on. Collapsing `\s+` handles tab, newline and friends but
 * leaves ESC (0x1B), BEL, BS and the rest of the C0/C1 range untouched, so a
 * hostile or merely echoing endpoint can embed ANSI screen-clear and
 * cursor-positioning sequences, or backspace runs that rewrite what was
 * already printed. That is terminal spoofing on the operator's screen and a
 * prompt-injection surface in the model's context, out of one string.
 *
 * Control characters are removed rather than escaped: the payload of an ANSI
 * sequence (`[2J`, `[1;1H`) is inert once its introducer is gone, and escaping
 * would only make the rendered text noisier without making it safer.
 *
 * Written with `\u` escapes rather than literal bytes so the pattern itself is
 * visible in review and in every tool that reads this file.
 */

/**
 * C0 controls, DEL (0x7F) and C1 controls (0x80–0x9F) — EXCEPT the whitespace
 * controls TAB, LF, VT, FF and CR.
 *
 * Those five are excluded deliberately. They cannot command a terminal, they
 * are ordinary word separators, and the callers that care already collapse
 * runs of whitespace. Removing them outright glues words together: a
 * two-line error body renders as "line oneline two", which is a legibility
 * regression introduced in the name of safety and buys nothing.
 */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000E-\u001F\u007F\u0080-\u009F]/g;

/** Strip every control character from a string. */
export function stripControlCharacters(value: string): string {
  return value.replace(CONTROL_CHARACTERS, "");
}
