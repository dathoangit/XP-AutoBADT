import { PDFDocument } from 'pdf-lib';

/**
 * Embed one or more PNG/JPEG images as A4 (or image-sized) PDF pages.
 */
export async function imagesToPdf(images: Uint8Array[]): Promise<{
  bytes: Uint8Array;
  pageCount: number;
}> {
  if (images.length === 0) {
    throw new Error('No images to convert');
  }

  const pdf = await PDFDocument.create();

  for (const imageBytes of images) {
    const isPng =
      imageBytes.length > 8 && imageBytes[0] === 0x89 && imageBytes[1] === 0x50;
    const embedded = isPng
      ? await pdf.embedPng(imageBytes)
      : await pdf.embedJpg(imageBytes);

    const page = pdf.addPage([embedded.width, embedded.height]);
    page.drawImage(embedded, {
      x: 0,
      y: 0,
      width: embedded.width,
      height: embedded.height
    });
  }

  const bytes = await pdf.save();
  return { bytes, pageCount: pdf.getPageCount() };
}
