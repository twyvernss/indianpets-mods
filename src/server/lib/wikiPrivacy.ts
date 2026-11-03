/**
 * Decides whether a wiki page is moderator-only, from the settings read back
 * straight after the app asked Reddit to make it so.
 *
 * WHY THIS IS NOT A SIMPLE `permLevel === 2`: Devvit 0.14.5 reads the
 * permission level back as 0 for every page, including pages a moderator can
 * see are set to "only mods may edit and view" on old.reddit. Reddit's JSON
 * names the field `permlevel`; Devvit's message expects `permLevel`, so the
 * value is dropped and the protobuf default of 0 is reported. Checked by hand
 * on r/indianpets_mods_dev on 3 Nov 2026.
 *
 * So a 0 is ambiguous, and the decision leans on `listed` instead, which does
 * read back correctly. The app sends `listed: false` and `permLevel: MODS_ONLY`
 * in ONE request. A page reading back as unlisted shows that request landed;
 * Reddit validates `permlevel` with the rest of the form, so it landed too.
 *
 * Still fails closed on anything else: a readable level that is not
 * moderators-only (1, approved contributors, is reported faithfully), or a page
 * still listed, which means the request did not take effect at all.
 */
export const WIKI_PERM_MODS_ONLY = 2;

export type WikiPrivacyVerdict = { ok: true; inferred: boolean } | { ok: false; reason: string };

export function judgeWikiPrivacy(readBack: { permLevel: unknown; listed: unknown }): WikiPrivacyVerdict {
  const level = Number(readBack.permLevel);

  if (level === WIKI_PERM_MODS_ONLY) return { ok: true, inferred: false };

  if (level === 0 && readBack.listed === false) return { ok: true, inferred: true };

  if (level === 0) {
    return {
      ok: false,
      reason:
        'Reddit still lists this page publicly, so the request to make it moderator-only did not take effect.',
    };
  }

  return {
    ok: false,
    reason: `Reddit reports this page's permission level as ${String(readBack.permLevel)}, not moderators-only (${WIKI_PERM_MODS_ONLY}).`,
  };
}
