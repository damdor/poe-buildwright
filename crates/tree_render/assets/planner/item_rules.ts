// Pure cross-game item rules. The catalogue supplies domains/tags; the
// UI only asks whether a family belongs to the selected base. Keeping
// this module DOM-free makes the data/UX boundary directly testable.

export interface RollFamily {
  domains?: string[];
  slots: string[];
  gates?: [string, number][][];
}

export function itemDomain(itemClass: string | undefined, tags?: Iterable<string>): string {
  if (itemClass === "Tincture") return "tincture";
  if (["LifeFlask", "ManaFlask", "HybridFlask", "UtilityFlask"].includes(itemClass ?? "")) {
    return "flask";
  }
  if (itemClass === "Jewel") {
    if (tags && [...tags].some(tag => /^expansion_jewel_(?:small|medium|large)$/.test(tag))) {
      return "cluster_jewel";
    }
    return "jewel";
  }
  return "item";
}

/** Reproduce the game's ordered spawn-weight gates. The first gate tag
 * the base carries decides; weight zero is an exclusion even when a
 * later tag would otherwise allow the family. */
export function canRollFamily(family: RollFamily, tags: Set<string>, domain: string): boolean {
  if (family.domains?.length && !family.domains.includes(domain)) return false;
  if (!family.gates?.length) return family.slots.some(slot => tags.has(slot));
  return family.gates.some(gate => {
    for (const [tag, weight] of gate) {
      if (tag === "default" || tags.has(tag)) return weight > 0;
    }
    return false;
  });
}
