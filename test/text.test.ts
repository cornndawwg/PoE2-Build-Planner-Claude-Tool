import { describe, expect, it } from "vitest";
import { stripMarkup } from "../src/text.js";

describe("stripMarkup", () => {
  it("keeps the display half of [Key|Display]", () => {
    expect(stripMarkup("Chance to [Ignite|Ignite] enemies")).toBe("Chance to Ignite enemies");
    expect(stripMarkup("Consumes a [ElementalInfusion|Infusion]")).toBe("Consumes a Infusion");
  });

  it("unwraps plain [Key]", () => {
    expect(stripMarkup("Launch a ball of [Fire]")).toBe("Launch a ball of Fire");
  });

  it("leaves text without markup alone", () => {
    expect(stripMarkup("+10 to Strength")).toBe("+10 to Strength");
  });
});
