/**
 * The name of a file a download hands to the browser.
 *
 * All four downloads of a space — the Markdown backup, the document outline,
 * the canvas image and the PDF — name their file after the one space name
 * `spaceDisplayName` settled on. So the decision of what a file may be called
 * belongs here once, not four times: a space called `2026/Q4 기획` has to
 * arrive as the same file name whichever of the four a reader picks, and
 * leaving three of them raw means the browser silently invents its own name
 * for those three and only the fourth is ours.
 *
 * The character set is Windows' forbidden set, which is the strictest of the
 * three platforms, so a name this produces is a legal file name everywhere.
 * Nothing else is touched — spaces, dots and Korean are part of what someone
 * named their space, and a name that holds no forbidden character comes back
 * exactly as it went in.
 *
 * This deliberately does not share code with the server. `internal/httpapi`
 * has four of its own — `safeFilename`, `dispositionSafe`,
 * `attachmentDisposition`, `handoffFilename` — but those answer a different
 * question: what a `Content-Disposition` header may carry over HTTP, where the
 * encoding rules, not the file system, set the limits. Merging contracts that
 * only look alike would make one of the two wrong. This one is about the four
 * names the web app writes into `anchor.download`, and about nothing else.
 *
 * The name arrives already trimmed and already defaulted by
 * `spaceDisplayName`, so there is no trimming or empty-name handling here.
 */
export function downloadFileName(name: string, extension: string, suffix?: string): string {
  const safe = name.replace(/[\\/:*?"<>|]/g, '-');
  return `umm-${safe}${suffix ? `-${suffix}` : ''}.${extension}`;
}
