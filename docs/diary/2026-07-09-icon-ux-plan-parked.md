# Parked: icon-driven UX for gems/skills/gear (do soon)

Prereq now in front of it: Abyssal Lich variant DISPLAY must be 100%
(panel node icons/names + portrait swap on variant select) — v1 only
covered data/agents/tooltips.

The parked plan (art is already extracted or proven extractable):

1. Gem picker rows get real icons — extraction chain proven: gem
   inventory art via ItemVisualIdentity resolves 100% of gems; hotbar
   skill art ~43% of actives. One `icons` pass in the sprites command →
   viewer/assets/skill_icons/*.png + an `icon` field in
   skill_catalogue.json. Rows: [gem art] Name … tags; str/dex/int chip
   stays as fallback.
2. Skills strip becomes socket-like — active gem icon with level badge,
   supports as a row of small round gem icons beneath; hover a support
   → its description tooltip (descriptions already in the catalogue).
3. Gear slots get item art + rarity color — uniques via
   UniqueStashLayout→ItemVisualIdentity (proven), bases too. GEAR strip
   rows: art thumbnail, name in rarity color, mods on hover.
4. Pickers inherit the art — combobox rows with icons for 1k gems / 392
   uniques.

Only step 1 is real plumbing (variant of the existing sprites command);
2–4 are CSS/HTML on shipped data. Also feeds agent-generated guides:
icon paths in the catalogues mean imported builds render with full art.

Other parked follow-ups: mods display text via CSD, item_catalogue
latest_stats truncation, timeline note-density design (cluster ticks +
importance tiers), KV binding for the live channel.
