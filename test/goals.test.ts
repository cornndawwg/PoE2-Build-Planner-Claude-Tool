// Goals from the intake, honest goal checks, and setup gaps.
import { describe, expect, it } from "vitest";
import { contentFor, gearTierFor, goalCheck, INTAKE_QUESTIONS, setupGaps } from "../src/build/goals.js";
import type { PlayerGem } from "../src/data/gamedata.js";
import { verdict } from "../src/engine/verdict.js";

const strong = { rareSeconds: 1, bossSeconds: 10, normalHits: 20, bossHits: 4, missingResistance: {} };
const weakBoss = { rareSeconds: 1, bossSeconds: 150, normalHits: 20, bossHits: 0.9, missingResistance: {} };
const gem = (name: string, kind: PlayerGem["kind"], tags: string[]) => ({ name, kind, tags }) as unknown as PlayerGem;

describe("intake", () => {
  it("asks about purpose, push, buttons and budget", () => {
    const ids = INTAKE_QUESTIONS.map((q) => q.id);
    for (const id of ["fantasy", "start", "purpose", "push", "buttons", "budget", "hardcore"]) expect(ids).toContain(id);
  });

  it("matches gear to budget only in the end game", () => {
    expect(gearTierFor("wealthy", 40)).toBe("budget");
    expect(gearTierFor("self-found", 90)).toBe("budget");
    expect(gearTierFor("modest", 90)).toBe("mid");
    expect(gearTierFor("wealthy", 90)).toBe("high");
    expect(contentFor("pinnacle", 40)).toBe("campaign");
    expect(contentFor("pinnacle", 90)).toBe("pinnacle");
    expect(contentFor("campaign", 90)).toBe("early maps");
  });
});

describe("goal check", () => {
  it("is on track when the numbers fit the goal", () => {
    const c = goalCheck(strong, 90, { purpose: "mapping", push: "T15" });
    expect(c.status).toBe("on track");
    expect(c.message).toMatch(/on track/);
  });

  it("says honestly when pinnacle bossing will be rough, with options", () => {
    const c = goalCheck(weakBoss, 90, { purpose: "bossing", push: "pinnacle", budget: "self-found" });
    expect(c.status).toBe("not realistic yet");
    expect(c.message).toMatch(/^Honestly/);
    expect(c.message).toMatch(/bosses take too long/);
    expect(c.options.some((o) => /optimize_build/.test(o))).toBe(true);
    expect(c.options.some((o) => /bigger budget/.test(o))).toBe(true);
    // Pinnacle is about bossing and survival, not clearing.
    expect(c.verdict.weakPoint).not.toBe("damage for clearing");
  });

  it("the same numbers are fine for mapping", () => {
    expect(goalCheck(weakBoss, 90, { purpose: "mapping", push: "T15" }).status).not.toBe("not realistic yet");
  });

  it("holds Hardcore to a higher survival bar", () => {
    const numbers = { ...strong, normalHits: 9, bossHits: 2 };
    expect(verdict({ ...numbers, content: "T15" }).survival).toBe("Comfortable");
    expect(verdict({ ...numbers, content: "T15" }, { purpose: "mapping", push: "T15", hardcore: true }).survival).toBe("Workable");
  });

  it("notes when an end-game goal is judged at a campaign level", () => {
    expect(goalCheck(strong, 40, { purpose: "bossing", push: "pinnacle" }).notes[0]).toMatch(/evaluate at level 85-90/);
  });
});

describe("setup gaps", () => {
  const sunder = gem("Sunder", "active", ["attack", "melee", "slam"]);
  it("flags unused Spirit, no second skill and no curse/warcry", () => {
    const gaps = setupGaps({ skills: [sunder], spirit: 100, spiritUnreserved: 100, buttons: "few", purpose: "bossing" });
    expect(gaps.some((g) => /100 of 100 Spirit is unused/.test(g))).toBe(true);
    expect(gaps.some((g) => /second skill/.test(g))).toBe(true);
    expect(gaps.some((g) => /curse, mark, warcry or banner/.test(g))).toBe(true);
  });

  it("leaves one-button builds alone apart from Spirit", () => {
    const gaps = setupGaps({ skills: [sunder, gem("Herald of Blood", "spirit", ["herald"])], spirit: 100, spiritUnreserved: 70, buttons: "one" });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatch(/70 of 100 Spirit/);
  });

  it("is happy with a full setup", () => {
    const skills = [sunder, gem("Boneshatter", "active", ["attack", "melee"]), gem("Infernal Cry", "active", ["warcry"]), gem("Herald of Blood", "spirit", ["herald"])];
    expect(setupGaps({ skills, spirit: 100, spiritUnreserved: 10, buttons: "few" })).toEqual([]);
  });
});
