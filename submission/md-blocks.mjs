import { existsSync } from "node:fs";
import { join } from "node:path";
// Minimal markdown tokenizer, shared by the HTML and .docx exporters.
//
// One parser, two renderers — the alternative was a second copy of the block
// detection inside the Word exporter, which would quietly drift from the HTML
// one and produce two different-looking submissions from the same source.
//
// Supports exactly what SUPERTEAM_SUBMISSION.md uses: headings, tables, fenced
// code, blockquotes, lists, rules, 📷 image markers, and inline
// code/bold/italic/strike/links. Not a general markdown implementation.

/** Split a line into styled runs: {text, code, bold, italic, strike, href}. */
export function inlineRuns(s) {
  const RE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(~~[^~]+~~)|(\[[^\]]+\]\([^)]+\))|(\*[^*\n]+\*)/g;
  const runs = [];
  let last = 0, m;
  const push = (text, style = {}) => { if (text) runs.push({ text, ...style }); };

  while ((m = RE.exec(s))) {
    push(s.slice(last, m.index));
    const t = m[0];
    if (m[1]) push(t.slice(1, -1), { code: true });
    else if (m[2]) push(t.slice(2, -2), { bold: true });
    else if (m[3]) push(t.slice(2, -2), { strike: true });
    else if (m[4]) {
      const link = t.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      push(link[1], { href: link[2] });
    } else if (m[5]) push(t.slice(1, -1), { italic: true });
    last = m.index + t.length;
  }
  push(s.slice(last));
  return runs.length ? runs : [{ text: "" }];
}

const cells = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
const isUl = (l) => /^\s*[-*]\s+/.test(l);
const isOl = (l) => /^\s*\d+\.\s+/.test(l);

/** Tokenize markdown into a flat list of block objects. */
export function blocks(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      const buf = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) buf.push(lines[i]);
      i++;
      out.push({ type: "pre", text: buf.join("\n") });
      continue;
    }

    if (line.startsWith("|") && /^\|[\s:|-]+\|$/.test(lines[i + 1] ?? "")) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].startsWith("|")) rows.push(cells(lines[i++]));
      out.push({ type: "table", head, rows });
      continue;
    }

    // 📷 marker: filenames are pulled from anywhere in the line so the wording
    // does not have to be uniform across the document.
    if (line.startsWith("📷")) {
      const files = [...new Set([...line.matchAll(/(\d{2}-[a-z0-9-]+\.png)/g)].map((m) => m[1]))];
      out.push({ type: "figure", files, caption: line.replace(/^📷\s*/, "") });
      i++;
      continue;
    }

    if (/^#{1,6}\s/.test(line)) {
      out.push({ type: "h", level: line.match(/^#+/)[0].length, text: line.replace(/^#+\s*/, "") });
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { out.push({ type: "hr" }); i++; continue; }

    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push({ type: "quote", text: buf.join(" ") });
      continue;
    }

    if (isUl(line) || isOl(line)) {
      const ordered = isOl(line);
      const items = [];
      while (i < lines.length && (isUl(lines[i]) || isOl(lines[i]) || /^\s{2,}\S/.test(lines[i]))) {
        if (isUl(lines[i]) || isOl(lines[i])) items.push(lines[i].replace(/^\s*(?:[-*]|\d+\.)\s+/, ""));
        else items[items.length - 1] += " " + lines[i].trim(); // wrapped continuation
        i++;
      }
      out.push({ type: "list", ordered, items });
      continue;
    }

    if (line.trim() === "") { i++; continue; }

    // Paragraph. Always consumes the first line: a line every branch above
    // declined and this guard also excludes would otherwise spin forever.
    const buf = [lines[i++]];
    while (i < lines.length && lines[i].trim() !== ""
           && !/^(#{1,6}\s|```|>|\||📷|-{3,})/.test(lines[i])
           && !isUl(lines[i]) && !isOl(lines[i])) buf.push(lines[i++]);
    out.push({ type: "p", text: buf.join(" ") });
  }
  return out;
}

/**
 * The files an exporter should embed for one screenshot.
 *
 * `capture.mjs` renders outputs longer than a page as `name.p1.png`,
 * `name.p2.png`, … beside the tall `name.png`. A document embeds the chunks —
 * a tall image gets scaled to the page and becomes unreadable — while a web
 * page uses the tall one, because browsers scroll. Falls back to the single
 * file when there are no chunks.
 */
export function screenshotPages(dir, file) {
  const base = file.replace(/\.png$/, "");
  const pages = [];
  for (let n = 1; ; n++) {
    const candidate = `${base}.p${n}.png`;
    if (!existsSync(join(dir, candidate))) break;
    pages.push(candidate);
  }
  return pages.length ? pages : [file];
}
