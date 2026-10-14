/** Keep a real Amazon HTTPS link under the original user gesture on iOS Home Screen.
 * The OS decides whether its universal link can open the installed app; never invent
 * an app scheme, resolve tracking redirects, or weaken email sanitization.
 */
export function preferNativeAmazonLinks(root: ParentNode, iosStandalone: boolean) {
 if (!iosStandalone) return;
 for (const anchor of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
  try {
   const url = new URL(anchor.href);
   if (url.protocol === "https:" && /^(?:www\.)?amazon\.(?:de|com|co\.uk|fr|it|es|nl|com\.au|co\.jp|ca)$/.test(url.hostname)) anchor.target = "_top";
  } catch { /* Sanitized fragment/mailto links retain their original behavior. */ }
 }
}
