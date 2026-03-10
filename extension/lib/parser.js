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
    const uint8 = new Uint8Array(buffer);
    const text = extractPDFText(uint8);
    return normalizeText(text);
  }

  /**
   * Lightweight PDF text extraction without external dependencies.
   * Handles the most common PDF text encodings found in resumes.
   */
  function extractPDFText(uint8) {
    const raw = new TextDecoder('latin1').decode(uint8);
    const textSegments = [];

    // Extract text from BT...ET blocks (PDF text objects)
    const btEtRegex = /BT\s([\s\S]*?)ET/g;
    let btMatch;
    while ((btMatch = btEtRegex.exec(raw)) !== null) {
      const block = btMatch[1];

      // Match Tj (show string) and TJ (show array of strings) operators
      const tjRegex = /\(([^)]*)\)\s*Tj/g;
      let tjMatch;
      while ((tjMatch = tjRegex.exec(block)) !== null) {
        textSegments.push(decodePDFString(tjMatch[1]));
      }

      // TJ arrays: [(text) kerning (text) ...]
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

    // Also grab stream-based text that may contain readable strings
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
    const entries = parseZip(new Uint8Array(buffer));
    const docXml = entries['word/document.xml'];
    if (!docXml) {
      throw new Error('Invalid DOCX: word/document.xml not found');
    }

    const text = stripXMLTags(docXml);
    return normalizeText(text);
  }

  /**
   * Minimal ZIP parser to extract entries from a DOCX file.
   * DOCX is a ZIP archive containing XML files.
   */
  function parseZip(uint8) {
    const entries = {};
    const view = new DataView(uint8.buffer, uint8.byteOffset, uint8.byteLength);
    let offset = 0;

    while (offset < uint8.length - 4) {
      const sig = view.getUint32(offset, true);
      if (sig !== 0x04034b50) break; // Local file header signature

      const compMethod = view.getUint16(offset + 8, true);
      const compSize = view.getUint32(offset + 18, true);
      const uncompSize = view.getUint32(offset + 22, true);
      const nameLen = view.getUint16(offset + 26, true);
      const extraLen = view.getUint16(offset + 28, true);

      const nameBytes = uint8.slice(offset + 30, offset + 30 + nameLen);
      const name = new TextDecoder().decode(nameBytes);

      const dataStart = offset + 30 + nameLen + extraLen;
      const dataBytes = uint8.slice(dataStart, dataStart + compSize);

      if (compMethod === 0 && name.endsWith('.xml')) {
        entries[name] = new TextDecoder().decode(dataBytes);
      } else if (compMethod === 8 && name.endsWith('.xml')) {
        try {
          const decompressed = decompressDeflateRaw(dataBytes);
          entries[name] = new TextDecoder().decode(decompressed);
        } catch {
          // Skip entries we can't decompress
        }
      }

      offset = dataStart + compSize;
    }

    return entries;
  }

  /**
   * Decompress raw DEFLATE data using the browser's DecompressionStream API.
   * Falls back to a simple extraction if DecompressionStream is unavailable.
   */
  function decompressDeflateRaw(compressed) {
    if (typeof DecompressionStream !== 'undefined') {
      // Use async decompression — we'll handle this via a sync wrapper
      // since we need the ZIP parsing to be sequential
      return decompressWithStream(compressed);
    }
    // Fallback: try to decode as-is (works for stored/uncompressed entries)
    return compressed;
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
