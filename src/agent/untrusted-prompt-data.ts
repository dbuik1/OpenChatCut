/**
 * Material that reaches a prompt from outside the user's own request —
 * transcript words lifted from an imported media file, caption text, scraped
 * page content — is data, never instruction. XML-escaping it and fencing it
 * between named markers means a line inside it that reads as a directive
 * cannot terminate the fence or be mistaken for one of the prompt's own
 * lines.
 */
export function encodeUntrustedPromptData(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** Wrap escaped untrusted material in a named data fence. */
export function fenceUntrustedPromptData(marker: string, text: string): string {
  return `<${marker}>\n${encodeUntrustedPromptData(text)}\n</${marker}>`;
}
