/**
 * How a user removes this server's access at YNAB itself (#85, #53c). The
 * consent page and the `ynab_disconnect` reply both use this text, so the two
 * can't drift. It is plain text with no markup, and the consent page
 * interpolates it as is. It starts in lower case because it continues a
 * sentence ("To end this access later, ...").
 */
export const YNAB_REVOKE_STEPS =
  "open your YNAB settings at app.ynab.com/settings, find Authorized Applications, and choose Revoke next to this server's app. It's listed under the name its owner gave it when registering it with YNAB.";
