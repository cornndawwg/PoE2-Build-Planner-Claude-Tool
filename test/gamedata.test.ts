import { describe, expect, it } from "vitest";
import { playableClasses } from "../src/data/gamedata.js";
import type { TreeExport } from "../src/data/types.js";

const tree: Pick<TreeExport, "classes" | "nodes"> = {
  classes: [
    { name: "Marauder", base_str: 15, base_dex: 7, base_int: 7, ascendancies: [] },
    {
      name: "Witch",
      base_str: 7,
      base_dex: 7,
      base_int: 15,
      ascendancies: [
        { id: "Witch1", name: "Infernalist" },
        { id: "Witch2", name: null },
      ],
    },
    { name: "Sorceress", base_str: 7, base_dex: 7, base_int: 15, ascendancies: [{ id: "Sorceress1", name: "Stormweaver" }] },
  ],
  nodes: {
    "100": { id: "marauder_start", classStartIndex: [0] },
    "200": { id: "witch_start", classStartIndex: [1, 2] },
  },
};

describe("playableClasses", () => {
  const classes = playableClasses(tree);

  it("drops classes with no released ascendancies", () => {
    expect(classes.map((c) => c.name)).toEqual(["Witch", "Sorceress"]);
  });

  it("drops unreleased ascendancies (null name)", () => {
    expect(classes[0]?.ascendancies).toEqual([{ id: "Witch1", name: "Infernalist" }]);
  });

  it("finds each class's start node, including shared starts", () => {
    expect(classes.map((c) => c.startNode)).toEqual(["200", "200"]);
  });
});
