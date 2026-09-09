/**
 * visibleText: what a person reads on a server-rendered page. Style and script blocks and
 * every tag removed, the five HTML entities decoded, whitespace collapsed. Lets a test assert
 * the exact sentence a deployer sees without caring how the markup wraps it.
 */
export function visibleText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
