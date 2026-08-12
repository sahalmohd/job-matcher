const ResumeParser = (() => {
  /**
   * Parse a resume file (PDF, DOCX, or plain text) and return extracted text.
   * Works entirely in the browser using ArrayBuffer inputs.
   */

  const SUPPORTED_TYPES = {
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'text/plain': 'text',
  };

  async function parse(file) {
    if (typeof file === 'string') {
      return normalizeText(file);
    }

    const type = SUPPORTED_TYPES[file.type];
    if (!type) {
      throw new Error(`Unsupported file type: ${file.type}. Supported: PDF, DOCX, plain text.`);
    }

    const buffer = await file.arrayBuffer();

    switch (type) {
      case 'pdf':
        return parsePDF(buffer);
      case 'docx':
        return parseDOCX(buffer);
      case 'text':
        return normalizeText(await file.text());
      default:
        throw new Error(`Unknown type: ${type}`);
    }
  }

  async function parsePDF(buffer) {
    // Use pdf.js if available (loaded in popup.html)
    if (typeof pdfjsLib !== 'undefined') {
      return parsePDFWithPdfJs(buffer);
    }
    // Fallback: lightweight regex extraction
    const uint8 = new Uint8Array(buffer);
    const text = extractPDFTextFallback(uint8);
    return normalizeText(text);
  }

  async function parsePDFWithPdfJs(buffer) {
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const strings = content.items.map((item) => item.str);
      pages.push(strings.join(' '));
    }
    return normalizeText(pages.join('\n'));
  }

  function extractPDFTextFallback(uint8) {
    const raw = new TextDecoder('latin1').decode(uint8);
    const textSegments = [];

    const btEtRegex = /BT\s([\s\S]*?)ET/g;
    let btMatch;
    while ((btMatch = btEtRegex.exec(raw)) !== null) {
      const block = btMatch[1];

      const tjRegex = /\(([^)]*)\)\s*Tj/g;
      let tjMatch;
      while ((tjMatch = tjRegex.exec(block)) !== null) {
        textSegments.push(decodePDFString(tjMatch[1]));
      }

      const tjArrayRegex = /\[((?:[^]]*?))\]\s*TJ/g;
      let arrMatch;
      while ((arrMatch = tjArrayRegex.exec(block)) !== null) {
        const inner = arrMatch[1];
        const strParts = /\(([^)]*)\)/g;
        let sp;
        while ((sp = strParts.exec(inner)) !== null) {
          textSegments.push(decodePDFString(sp[1]));
        }
      }
    }

    if (textSegments.length === 0) {
      const readable = raw.match(/[\x20-\x7E]{4,}/g) || [];
      const filtered = readable.filter(
        (s) => !s.startsWith('/') && !s.startsWith('%') && !s.match(/^\d+\s+\d+\s+obj/)
      );
      return filtered.join(' ');
    }

    return textSegments.join(' ');
  }

  function decodePDFString(s) {
    return s
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\\\\/g, '\\');
  }

  async function parseDOCX(buffer) {
    const docXml = await readZipEntry(new Uint8Array(buffer), 'word/document.xml');
    if (!docXml) {
      throw new Error('Invalid DOCX: word/document.xml not found');
    }

    const text = stripXMLTags(docXml);
    return normalizeText(text);
  }

  /**
   * Read one entry out of a ZIP archive as text. DOCX is a ZIP of XML parts.
   *
   * Entries are located through the central directory rather than by walking
   * local file headers. Word sets the general-purpose "data descriptor" flag
   * (bit 3), which leaves the compressed and uncompressed sizes as zero in the
   * local header and writes them *after* the data instead — so a local-header
   * walk reads a zero-length body and then desynchronises. The central
   * directory always carries the true sizes.
   */
  async function readZipEntry(uint8, wantedName) {
    const view = new DataView(uint8.buffer, uint8.byteOffset, uint8.byteLength);
    const eocdOffset = findEndOfCentralDirectory(view, uint8.length);
    if (eocdOffset < 0) {
      throw new Error('Invalid DOCX: not a ZIP archive (no end-of-central-directory record)');
    }

    const entryCount = view.getUint16(eocdOffset + 10, true);
    let offset = view.getUint32(eocdOffset + 16, true);

    for (let i = 0; i < entryCount; i++) {
      if (offset + 46 > uint8.length) break;
      if (view.getUint32(offset, true) !== 0x02014b50) break; // Central directory header

      const compMethod = view.getUint16(offset + 10, true);
      const compSize = view.getUint32(offset + 20, true);
      const nameLen = view.getUint16(offset + 28, true);
      const extraLen = view.getUint16(offset + 30, true);
      const commentLen = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);

      const name = new TextDecoder().decode(uint8.subarray(offset + 46, offset + 46 + nameLen));

      if (name === wantedName) {
        return decodeZipEntry(uint8, view, localOffset, compMethod, compSize, name);
      }

      offset += 46 + nameLen + extraLen + commentLen;
    }

    return null;
  }

  /** Read and decompress a single entry given its central-directory metadata. */
  async function decodeZipEntry(uint8, view, localOffset, compMethod, compSize, name) {
    if (view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error(`Invalid DOCX: bad local header for ${name}`);
    }

    // The local header's own name/extra lengths are authoritative for locating
    // the data; the extra field often differs in length from the central one.
    const nameLen = view.getUint16(localOffset + 26, true);
    const extraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + nameLen + extraLen;
    const data = uint8.subarray(dataStart, dataStart + compSize);

    if (compMethod === 0) return new TextDecoder().decode(data);

    if (compMethod !== 8) {
      throw new Error(`Unsupported DOCX compression method ${compMethod} for ${name}`);
    }

    if (typeof DecompressionStream === 'undefined') {
      throw new Error('Cannot read DOCX: DecompressionStream is unavailable in this browser');
    }

    // This await is the whole point. The previous code called an async
    // decompressor synchronously and handed the resulting Promise to
    // TextDecoder.decode(), which threw a TypeError that an empty catch then
    // swallowed — so every DOCX failed with a misleading "document.xml not
    // found".
    const decompressed = await decompressWithStream(data);
    return new TextDecoder().decode(decompressed);
  }

  /**
   * Locate the end-of-central-directory record by scanning backwards for its
   * signature. It sits at the very end of the file unless there is a trailing
   * comment, which is capped at 64KB.
   */
  function findEndOfCentralDirectory(view, length) {
    const minOffset = Math.max(0, length - 0xffff - 22);
    for (let i = length - 22; i >= minOffset; i--) {
      if (view.getUint32(i, true) === 0x06054b50) return i;
    }
    return -1;
  }

  async function decompressWithStream(compressed) {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();

    writer.write(compressed);
    writer.close();

    const chunks = [];
    let totalLen = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalLen += value.length;
    }

    const result = new Uint8Array(totalLen);
    let pos = 0;
    for (const chunk of chunks) {
      result.set(chunk, pos);
      pos += chunk.length;
    }
    return result;
  }

  function stripXMLTags(xml) {
    // Insert spaces/newlines at paragraph and line break boundaries
    return xml
      .replace(/<\/w:p>/g, '\n')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }

  function normalizeText(text) {
    return text
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function getSupportedTypes() {
    return Object.keys(SUPPORTED_TYPES);
  }

  return { parse, normalizeText, getSupportedTypes };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ResumeParser;
}
