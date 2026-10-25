import { PDFDocument } from 'pdf-lib';

/**
 * Merge PDF byte arrays in order into a single document.
 */
export async function mergePdfs(parts: Uint8Array[]): Promise<{
  bytes: Uint8Array;
  pageCount: number;
}> {
  if (parts.length === 0) {
    throw new Error('No PDF parts to merge');
  }

  const merged = await PDFDocument.create();

  for (const part of parts) {
    const doc = await PDFDocument.load(part, { ignoreEncryption: true });
    const pages = await merged.copyPages(doc, doc.getPageIndices());
    for (const page of pages) {
      merged.addPage(page);
    }
  }

  const bytes = await merged.save();
  return { bytes, pageCount: merged.getPageCount() };
}
