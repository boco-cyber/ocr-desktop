/**
 * DOCX output builder
 * Converts OCR results (array of { index, text } pages) to a .docx buffer.
 * Uses the `docx` npm package (no external dependencies).
 */
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');

async function buildDocx(jobName, pages, { rtl = false } = {}) {
  const children = [];
  const bodyFont = rtl ? 'Arial' : 'Calibri';

  // Document title
  children.push(new Paragraph({
    text:    `OCR Result: ${jobName}`,
    heading: HeadingLevel.HEADING_1,
  }));

  for (const page of pages) {
    // Page separator heading (only for multi-page docs)
    if (pages.length > 1) {
      children.push(new Paragraph({
        text:    `Page ${page.index + 1}`,
        heading: HeadingLevel.HEADING_2,
      }));
    }

    // Split text into lines, each line becomes a Paragraph
    const lines = (page.text || '').split('\n');
    for (const line of lines) {
      children.push(new Paragraph({
        ...(rtl ? { bidirectional: true } : {}),
        children: [new TextRun({ text: line, size: 24, font: bodyFont })],
      }));
    }

    // Blank paragraph between pages
    if (pages.length > 1) {
      children.push(new Paragraph({ text: '' }));
    }
  }

  const doc = new Document({
    sections: [{
      properties: {},
      children,
    }],
  });

  return Packer.toBuffer(doc);
}

module.exports = { buildDocx };
