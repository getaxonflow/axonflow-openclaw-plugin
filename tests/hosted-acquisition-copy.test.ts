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

const staleLegacyOfferClaims = [
  /\$9\.99(?:\s+USD)?[^\n]{0,80}\bone[- ]time\b/i,
  /\$9\.99(?:\s+USD)?[^\n]{0,80}\b90[- ]day\s+license\b/i,
  /\$9\.99(?:\s+USD)?[^\n]{0,80}\bno auto[- ]renewal\b/i,
];

const staleAcquisitionClaims = [
  ...staleClosedEnrollmentClaims,
  ...staleLegacyOfferClaims,
];

const expectNoStaleAcquisitionClaims = (copy: string): void => {
  for (const staleClaim of staleAcquisitionClaims) {
    expect(copy).not.toMatch(staleClaim);
  }
};

describe("Hosted Starter acquisition copy", () => {
  const readme = readRepoFile("README.md");
  const skill = readRepoFile("clawhub/2.6.0/SKILL.md");
  const publishRunbook = readRepoFile("clawhub/PUBLISH-2.6.0.md");

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
  ])("does not regress %s to a stale acquisition offer", (_name, copy) => {
    expectNoStaleAcquisitionClaims(copy);
  });

  it("rejects the obsolete one-time 90-day offer", () => {
    const plantedLegacyOffer =
      "$9.99 one-time, 90-day license, no auto-renewal.";

    for (const staleClaim of staleLegacyOfferClaims) {
      expect(plantedLegacyOffer).toMatch(staleClaim);
    }
    expect(() => expectNoStaleAcquisitionClaims(plantedLegacyOffer)).toThrow();
  });

  it("pins the manually published skill to the reviewed runtime floor", () => {
    expect(skill).toContain(
      "openclaw plugins install @axonflow/openclaw@2.10.4",
    );
    expect(skill).toContain(
      "Requires OpenClaw 2026.6.6+ and `@axonflow/openclaw` 2.10.4+.",
    );
  });

  it("admits the skill as a candidate and withdraws a non-clean version", () => {
    expect(publishRunbook).toContain("--tags candidate");
    expect(publishRunbook).not.toContain("--tags latest");
    expect(publishRunbook).toContain(
      "clawhub delete @axonflow/governance-policies",
    );
    expect(publishRunbook).toContain("--version 2.6.0");
    expect(publishRunbook).toContain(
      "! clawhub inspect @axonflow/governance-policies --tag candidate --json",
    );
    expect(publishRunbook).toContain(
      "clawhub hide @axonflow/governance-policies",
    );
    expect(publishRunbook).not.toMatch(/has no\s+hide, delete, or withdraw/i);
  });
});
