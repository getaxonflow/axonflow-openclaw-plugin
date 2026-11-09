import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = process.cwd();
const readRepoFile = (relativePath: string): string =>
  readFileSync(resolve(repoRoot, relativePath), "utf8");

const staleClosedEnrollmentClaims = [
  /paid enrollment and checkout are (?:not yet open|currently closed)/i,
  /when enrollment opens/i,
  /once paid enrollment opens/i,
  /checkout is currently closed/i,
];

describe("Hosted Starter acquisition copy", () => {
  const readme = readRepoFile("README.md");
  const skill = readRepoFile("clawhub/2.6.0/SKILL.md");

  it.each([
    ["plugin README", readme],
    ["ClawHub skill", skill],
  ])("keeps %s on the live verified purchase and link journey", (_name, copy) => {
    expect(copy).toContain("https://getaxonflow.com/saas-pricing/");
    expect(copy).toMatch(/\$9\.99 USD per month/i);
    expect(copy).toMatch(/verify your email/i);
    expect(copy).toMatch(/secure Checkout/i);
    expect(copy).toMatch(/axonflow-openclaw-link\.mjs/);
  });

  it.each([
    ["plugin README", readme],
    ["ClawHub skill", skill],
  ])("does not regress %s to closed-enrollment copy", (_name, copy) => {
    for (const staleClaim of staleClosedEnrollmentClaims) {
      expect(copy).not.toMatch(staleClaim);
    }
  });

  it("pins the manually published skill to the reviewed runtime floor", () => {
    expect(skill).toContain(
      "openclaw plugins install @axonflow/openclaw@2.10.4",
    );
    expect(skill).toContain(
      "Requires OpenClaw 2026.6.6+ and `@axonflow/openclaw` 2.10.4+.",
    );
  });
});
