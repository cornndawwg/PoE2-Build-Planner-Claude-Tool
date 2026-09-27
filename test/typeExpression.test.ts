import { describe, expect, it } from "vitest";
import { matchesTypeExpression } from "../src/skills/typeExpression.js";

const types = new Set(["Spell", "Projectile", "Fire"]);

describe("matchesTypeExpression", () => {
  it("treats a plain list as any-of", () => {
    expect(matchesTypeExpression(["Attack", "Spell"], types)).toBe(true);
    expect(matchesTypeExpression(["Attack", "Melee"], types)).toBe(false);
  });

  it("supports AND", () => {
    expect(matchesTypeExpression(["Spell", "Fire", "AND"], types)).toBe(true);
    expect(matchesTypeExpression(["Spell", "Cold", "AND"], types)).toBe(false);
  });

  it("supports NOT", () => {
    expect(matchesTypeExpression(["Attack", "NOT"], types)).toBe(true);
    expect(matchesTypeExpression(["Spell", "NOT"], types)).toBe(false);
  });

  it("supports OR inside a larger expression", () => {
    // (Attack OR Spell) AND Fire
    expect(matchesTypeExpression(["Attack", "Spell", "OR", "Fire", "AND"], types)).toBe(true);
    // (Attack OR Melee) AND Fire
    expect(matchesTypeExpression(["Attack", "Melee", "OR", "Fire", "AND"], types)).toBe(false);
  });

  it("counts minion types when given", () => {
    expect(matchesTypeExpression(["Attack"], types, new Set(["Attack"]))).toBe(true);
  });

  it("is false for an empty expression", () => {
    expect(matchesTypeExpression([], types)).toBe(false);
  });
});
