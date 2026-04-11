class TextChunkingService {
  buildFromPlainText({ text, maxChars = 1400 }) {
    return this.#chunkParagraphSets([
      {
        label: 'Source text',
        paragraphs: this.#splitParagraphs(text),
        pageNumber: null,
      },
    ], maxChars);
  }

  buildFromPages({ pages, maxChars = 1400 }) {
    const sets = (pages || []).map(page => ({
      label: `Page ${page.pageNumber}`,
      pageNumber: page.pageNumber,
      paragraphs: this.#splitParagraphs(page.text || ''),
    }));
    return this.#chunkParagraphSets(sets, maxChars);
  }

  #splitParagraphs(text) {
    const normalized = (text || '').replace(/\r\n?/g, '\n').trim();
    if (!normalized) return [];
    return normalized
      .split(/\n{2,}/)
      .map(paragraph => paragraph.trim())
      .filter(Boolean);
  }

  #chunkParagraphSets(sets, maxChars) {
    const chunks = [];
    let chunkNumber = 1;

    for (const set of sets) {
      let current = '';
      for (const paragraph of set.paragraphs) {
        const nextText = current ? `${current}\n\n${paragraph}` : paragraph;
        if (current && nextText.length > maxChars) {
          chunks.push({
            chunkNumber,
            sourceLabel: set.label,
            pageNumber: set.pageNumber,
            sourceText: current,
          });
          chunkNumber += 1;
          current = paragraph;
          continue;
        }
        current = nextText;
      }

      if (current) {
        chunks.push({
          chunkNumber,
          sourceLabel: set.label,
          pageNumber: set.pageNumber,
          sourceText: current,
        });
        chunkNumber += 1;
      }
    }

    return chunks;
  }
}

module.exports = { TextChunkingService };
