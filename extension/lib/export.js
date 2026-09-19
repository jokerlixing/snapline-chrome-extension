import { jsPDF } from 'jspdf';

export function safeFilename(value, extension) {
  let name = String(value || '我的网页').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').trim().slice(0, 100);
  name = name.replace(/\.(png|jpe?g|webp|pdf)$/i, '');
  if (!name || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) name = '我的网页';
  return `${name}.${extension === 'jpeg' ? 'jpg' : extension}`;
}

export function planPdfPages(width, height, layout = 'a4', margin = 10) {
  if (![width, height].every(x => Number.isFinite(x) && x > 0)) throw new Error('截图尺寸无效，请重新生成预览。');
  if (!['a4', 'letter', 'long'].includes(layout)) throw new Error('PDF 页面设置无效。');
  if (![0, 10, 20].includes(margin)) throw new Error('PDF 页边距设置无效。');
  const paperWidth = layout === 'letter' ? 215.9 : 210;
  const imageWidth = paperWidth - margin * 2;
  const paperHeight = layout === 'long' ? imageWidth * height / width + margin * 2 : layout === 'letter' ? 279.4 : 297;
  if (paperHeight > 5080) throw new Error('网页超过单页 PDF 的长度限制，请选择「A4 · 自动分页」。');
  const maxSlice = layout === 'long' ? height : Math.max(1, Math.floor((paperHeight - margin * 2) * width / imageWidth));
  const slices = [];
  for (let y = 0; y < height; y += maxSlice) slices.push({ y, height: Math.min(maxSlice, height - y) });
  if (slices.length > 250) throw new Error('PDF 页数过多，请降低清晰度或截取当前可见区域。');
  return { paperWidth, paperHeight, imageWidth, margin, slices };
}

export function planRasterExport(width, height, format) {
  if (![width, height].every(value => Number.isInteger(value) && value > 0)) throw new Error('截图尺寸无效，请重新生成预览。');
  // Lossy WebP uses 14-bit dimensions. Chromium can silently crop larger
  // canvases, so fit the entire image within the format limit before encoding.
  // https://developers.google.com/speed/webp/faq#what_is_the_maximum_size_a_webp_image_can_be
  const scale = format === 'webp' ? Math.min(1, 16383 / Math.max(width, height)) : 1;
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), scaled: scale < 1 };
}

export async function encodeExport(record, { format, quality = 92, layout = 'a4', margin = 10 }) {
  if (!record?.blob) throw new Error('请先生成网页预览。');
  if (!['png', 'jpeg', 'webp', 'pdf'].includes(format)) throw new Error('请选择一种有效的导出格式。');
  if (format === 'png') return record.blob;
  const bitmap = await createImageBitmap(record.blob, { colorSpaceConversion: 'default' });
  const canvas = document.createElement('canvas');
  try {
    const output = planRasterExport(bitmap.width, bitmap.height, format);
    canvas.width = output.width;
    canvas.height = output.height;
    const context = canvas.getContext('2d', { colorSpace: 'srgb' });
    if (!context) throw new Error('无法分配图片画布，请降低清晰度。');
    if (format === 'jpeg' || format === 'pdf') { context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); }
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (format !== 'pdf') {
      const blob = await new Promise(resolve => canvas.toBlob(resolve, `image/${format}`, Math.max(.3, Math.min(1, quality / 100))));
      if (!blob || blob.type !== `image/${format}`) throw new Error('浏览器无法生成这个格式，请改用 PNG。');
      const encoded = await createImageBitmap(blob, { colorSpaceConversion: 'default' });
      try {
        if (encoded.width !== canvas.width || encoded.height !== canvas.height) throw new Error('导出的图片尺寸不完整，请改用 PNG 或 PDF。');
      } finally { encoded.close(); }
      return blob;
    }
    const plan = planPdfPages(canvas.width, canvas.height, layout, margin);
    const pdf = new jsPDF({ orientation: plan.paperWidth > plan.paperHeight ? 'landscape' : 'portrait', unit: 'mm', format: [plan.paperWidth, plan.paperHeight], compress: true });
    pdf.setProperties({ title: 'Snapline capture', creator: 'Snapline', subject: 'Locally captured webpage' });
    const slice = document.createElement('canvas');
    slice.width = canvas.width;
    try {
      for (let i = 0; i < plan.slices.length; i++) {
        const part = plan.slices[i];
        if (i) pdf.addPage([plan.paperWidth, plan.paperHeight], plan.paperWidth > plan.paperHeight ? 'landscape' : 'portrait');
        slice.height = part.height;
        const sliceContext = slice.getContext('2d', { colorSpace: 'srgb' });
        if (!sliceContext) throw new Error('无法分配 PDF 页面画布，请降低清晰度。');
        sliceContext.drawImage(canvas, 0, part.y, canvas.width, part.height, 0, 0, canvas.width, part.height);
        pdf.addImage(slice.toDataURL('image/jpeg', .96), 'JPEG', margin, margin, plan.imageWidth, part.height * plan.imageWidth / canvas.width, `page-${i}`, 'FAST');
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      return pdf.output('blob');
    } finally { slice.width = 0; slice.height = 0; }
  } finally { bitmap.close(); canvas.width = 0; canvas.height = 0; }
}
