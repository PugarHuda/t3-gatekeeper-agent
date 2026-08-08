// Build submission.docx from SUPERTEAM_SUBMISSION.md, with the screenshots
// embedded as real image parts.
//
// Why a .docx and not the HTML page: uploading a file to Drive and opening it
// with Google Docs keeps the images, whereas "paste a web page" depends on the
// clipboard round trip working. This is the artifact you hand in.
//
// No dependencies — a .docx is a ZIP of XML, and the ZIP writer below is ~60
// lines (stored entries, so no deflate bookkeeping).
//
//   node make-docx.mjs   ->  submission/submission.docx
import { readFileSync, writeFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { blocks, inlineRuns } from "./md-blocks.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, "screenshots", "out");
const OUT = path.join(HERE, "submission.docx");

const xmlEsc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

// ── ZIP (stored, no compression) ────────────────────────────────────────────
function zip(files) {
  const chunks = [], central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const crc = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(0, 8);           // method: stored
    local.writeUInt32LE(0, 10);          // time+date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(0, 12);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(body.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(0, 42 - 4);         // relative offset of local header
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, end]);
}

// ── image sizing ────────────────────────────────────────────────────────────
const EMU_PER_PX = 9525;
const MAX_W = 6.0 * 914400; // 6in inside 1in margins on Letter

function pngSize(buf) {
  // IHDR is always the first chunk: width/height are big-endian at 16 and 20.
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// ── OOXML ───────────────────────────────────────────────────────────────────
const HEAD_SIZE = { 1: 36, 2: 26, 3: 22, 4: 20, 5: 20, 6: 20 }; // half-points

function runsXml(runs, { size = 21, color = "111111" } = {}) {
  return runs.map((r) => {
    if (!r.text) return "";
    const props = [];
    if (r.bold) props.push("<w:b/>");
    if (r.italic) props.push("<w:i/>");
    if (r.strike) props.push("<w:strike/>");
    if (r.code) props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>',
      '<w:shd w:val="clear" w:fill="F0F2F4"/>');
    props.push(`<w:sz w:val="${r.code ? size - 3 : size}"/>`);
    props.push(`<w:color w:val="${r.href ? "1155CC" : color}"/>`);
    if (r.href) props.push("<w:u w:val=\"single\"/>");
    const run = `<w:r><w:rPr>${props.join("")}</w:rPr>`
      + `<w:t xml:space="preserve">${xmlEsc(r.text)}</w:t></w:r>`;
    // Links use the plain-text URL as the display target via a field-less run;
    // Google Docs autolinks them on import, which avoids per-link relationships.
    return run;
  }).join("");
}

const para = (inner, { spacing = 120, align, ind } = {}) =>
  `<w:p><w:pPr>${align ? `<w:jc w:val="${align}"/>` : ""}`
  + `${ind ? `<w:ind w:left="${ind}"/>` : ""}`
  + `<w:spacing w:before="${spacing}" w:after="${spacing}"/></w:pPr>${inner}</w:p>`;

function build() {
  const md = readFileSync(path.join(HERE, "SUPERTEAM_SUBMISSION.md"), "utf8");
  const body = [];
  const media = [];      // {name, data}
  const rels = [];       // {id, target}

  for (const b of blocks(md)) {
    switch (b.type) {
      case "h": {
        const sz = HEAD_SIZE[b.level] ?? 20;
        const runs = inlineRuns(b.text).map((r) => ({ ...r, bold: true }));
        body.push(para(runsXml(runs, { size: sz, color: "1a1a1a" }),
          { spacing: b.level <= 2 ? 260 : 180 }));
        break;
      }
      case "p":
        body.push(para(runsXml(inlineRuns(b.text))));
        break;
      case "quote":
        body.push(para(runsXml(inlineRuns(b.text), { color: "444444" }), { ind: 360 }));
        break;
      case "hr":
        body.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:color="CCCCCC"/>'
          + "</w:pBdr></w:pPr></w:p>");
        break;
      case "list":
        b.items.forEach((it, n) => {
          const bullet = b.ordered ? `${n + 1}. ` : "• ";
          body.push(para(runsXml([{ text: bullet }, ...inlineRuns(it)]),
            { spacing: 60, ind: 360 }));
        });
        break;
      case "pre": {
        const lines = b.text.split("\n").map((l) =>
          `<w:p><w:pPr><w:shd w:val="clear" w:fill="F6F8FA"/><w:spacing w:before="0" w:after="0"/>`
          + `</w:pPr><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>`
          + `<w:sz w:val="17"/></w:rPr><w:t xml:space="preserve">${xmlEsc(l || " ")}</w:t></w:r></w:p>`);
        body.push(lines.join(""));
        break;
      }
      case "table": {
        const w = Math.floor(9360 / Math.max(b.head.length, 1));
        const cell = (text, header) =>
          `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>`
          + (header ? '<w:shd w:val="clear" w:fill="F1F3F5"/>' : "")
          + `</w:tcPr>${para(runsXml(inlineRuns(text).map((r) => header ? { ...r, bold: true } : r),
            { size: 19 }), { spacing: 40 })}</w:tc>`;
        const row = (cs, header) => `<w:tr>${cs.map((c) => cell(c, header)).join("")}</w:tr>`;
        body.push(
          `<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/>`
          + `<w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"]
            .map((s) => `<w:${s} w:val="single" w:sz="4" w:color="BBBBBB"/>`).join("")}`
          + `</w:tblBorders></w:tblPr>`
          + row(b.head, true) + b.rows.map((r) => row(r, false)).join("")
          + "</w:tbl>" + para(""),
        );
        break;
      }
      case "figure": {
        body.push(para(runsXml(inlineRuns(b.caption), { size: 18, color: "444444" }),
          { spacing: 80 }));
        for (const file of b.files) {
          let data;
          try { data = readFileSync(path.join(SHOTS, file)); }
          catch { console.warn(`  ! missing screenshot ${file} — skipped`); continue; }
          const { w, h } = pngSize(data);
          const cx = Math.min(MAX_W, w * EMU_PER_PX);
          const cy = Math.round(cx * (h / w));
          const id = `rId${100 + media.length}`;
          media.push({ name: `word/media/${file}`, data });
          rels.push({ id, target: `media/${file}` });
          const n = media.length;
          body.push(
            `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="80" w:after="200"/></w:pPr>`
            + `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">`
            + `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Picture ${n}"/>`
            + `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">`
            + `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
            + `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`
            + `<pic:nvPicPr><pic:cNvPr id="${n}" name="${file}"/><pic:cNvPicPr/></pic:nvPicPr>`
            + `<pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
            + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
            + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
            + `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`,
          );
        }
        break;
      }
    }
  }

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
<w:body>${body.join("")}
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>
<w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/></w:sectPr>
</w:body></w:document>`;

  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${rels.map((r) => `<Relationship Id="${r.id}" Target="${r.target}" `
  + `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"/>`).join("")}
</Relationships>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Target="word/document.xml"
 Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"/>
</Relationships>`;

  return zip([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rootRels },
    { name: "word/document.xml", data: document },
    { name: "word/_rels/document.xml.rels", data: docRels },
    ...media,
  ]);
}

const buf = build();
writeFileSync(OUT, buf);
console.log(`wrote ${OUT} (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
