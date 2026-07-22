/// <reference lib="deno.ns" />

import { canRollFamily, itemDomain } from "./item_rules.ts";
import type { RollFamily } from "./item_rules.ts";

Deno.test("item classes map to isolated mod domains", () => {
  const got = ["Ring", "LifeFlask", "UtilityFlask", "Tincture", "Jewel"].map(itemDomain);
  const want = ["item", "flask", "flask", "tincture", "jewel"];
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`expected ${want}, got ${got}`);
  }
});

Deno.test("domain filtering prevents flask affixes leaking onto gear", () => {
  const family: RollFamily = {
    domains: ["flask"],
    slots: ["default"],
    gates: [[["default", 1]]],
  };
  if (canRollFamily(family, new Set(["ring"]), "item")) {
    throw new Error("a flask-domain family rolled on an item-domain ring");
  }
  if (!canRollFamily(family, new Set(["flask"]), "flask")) {
    throw new Error("a flask-domain family did not roll on a flask");
  }
});

Deno.test("ordered spawn gates preserve explicit exclusions", () => {
  const family: RollFamily = {
    slots: ["weapon"],
    gates: [[ ["sword", 0], ["weapon", 100], ["default", 0] ]],
  };
  if (canRollFamily(family, new Set(["sword", "weapon"]), "item")) {
    throw new Error("the first matching zero-weight gate must exclude the family");
  }
});
