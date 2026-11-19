/** Wraps page text so it is clearly data, and neutralises any tag inside it that could close or reopen the fence. */
export function fence(text: string): string {
  const safe = text.replace(/<(\s*\/?\s*)web_content/gi, '&lt;$1web_content');
  return `<web_content untrusted>\n${safe}\n</web_content>`;
}
