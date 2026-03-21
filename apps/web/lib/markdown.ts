/**
 * 간단한 마크다운 → HTML 변환 (marked 의존성 없이)
 * 지원: h1-h3, **bold**, `code`, ```code block```, table, ul/ol, blockquote, hr, p
 */
export function renderMarkdown(md: string): string {
  let html = escapeForProcessing(md);

  // Code blocks (```)
  html = html.replace(/```[\w]*\n([\s\S]*?)```/g, (_, code) => {
    return `<pre><code>${unescapeForCode(code.trimEnd())}</code></pre>`;
  });

  // Headings
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Horizontal rule
  html = html.replace(/^---+$/gm, '<hr>');

  // Blockquote
  html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');

  // Tables
  html = html.replace(/(\|.+\|\n)+/g, (table) => {
    const rows = table.trim().split('\n');
    if (rows.length < 2) return table;
    const header = rows[0];
    const body = rows.slice(2); // skip separator row
    const thCells = header.split('|').filter(c => c.trim()).map(c => `<th>${c.trim()}</th>`).join('');
    const bodyRows = body.map(row => {
      const cells = row.split('|').filter(c => c.trim()).map(c => `<td>${c.trim()}</td>`).join('');
      return `<tr>${cells}</tr>`;
    }).join('');
    return `<table><thead><tr>${thCells}</tr></thead><tbody>${bodyRows}</tbody></table>`;
  });

  // Unordered list
  html = processLists(html);

  // Inline: bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Inline: italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Inline: code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Paragraphs: wrap non-tagged lines
  html = html
    .split('\n')
    .reduce((acc, line) => {
      const trimmed = line.trim();
      if (!trimmed) return acc + '\n';
      if (/^<(h[1-6]|pre|table|ul|ol|li|blockquote|hr)/.test(trimmed)) {
        return acc + trimmed + '\n';
      }
      return acc + `<p>${trimmed}</p>\n`;
    }, '');

  return html;
}

function escapeForProcessing(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function unescapeForCode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function processLists(html: string): string {
  const lines = html.split('\n');
  const result: string[] = [];
  let inUl = false;
  let inOl = false;
  let olIndex = 0;

  for (const line of lines) {
    const ulMatch = line.match(/^[-*] (.+)$/);
    const olMatch = line.match(/^\d+\. (.+)$/);

    if (ulMatch) {
      if (!inUl) { result.push('<ul>'); inUl = true; }
      if (inOl) { result.push('</ol>'); inOl = false; olIndex = 0; }
      result.push(`<li>${ulMatch[1]}</li>`);
    } else if (olMatch) {
      if (!inOl) { result.push('<ol>'); inOl = true; }
      if (inUl) { result.push('</ul>'); inUl = false; }
      result.push(`<li>${olMatch[1]}</li>`);
    } else {
      if (inUl) { result.push('</ul>'); inUl = false; }
      if (inOl) { result.push('</ol>'); inOl = false; olIndex = 0; }
      result.push(line);
    }
  }
  if (inUl) result.push('</ul>');
  if (inOl) result.push('</ol>');
  return result.join('\n');
}
