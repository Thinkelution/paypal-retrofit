/**
 * A small text-only PDF (A4, Helvetica) for documents retrofit hands to PayPal, such as dispute evidence. No
 * dependencies: plain PDF 1.4 objects, Latin-1 text, long lines wrapped, as many pages as needed.
 */
export function textPdf(title: string, lines: string[]): Buffer {
  const width = 92;
  const wrap = (s: string): string[] => {
    const out: string[] = [];
    let line = '';
    for (const word of s.split(/\s+/)) {
      if ((line + ' ' + word).trim().length > width) {
        if (line) out.push(line);
        line = word.length > width ? word.slice(0, width) : word;
      } else line = (line + ' ' + word).trim();
    }
    out.push(line);
    return out;
  };
  const esc = (s: string) =>
    s
      .replace(
        /[^\x20-\x7e\xa0-\xff]/g,
        (c) => ({ '’': "'", '‘': "'", '“': '"', '”': '"', '–': '-', '—': '-', '•': '*' })[c] ?? '?',
      )
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)');
  const body = lines.flatMap((l) => (l === '' ? [''] : wrap(l)));
  const perPage = 50;
  const pages: string[][] = [];
  for (let i = 0; i < Math.max(1, body.length); i += perPage) pages.push(body.slice(i, i + perPage));

  const objects: string[] = [];
  const add = (o: string) => objects.push(o) && objects.length;
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('PAGES');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  pages.forEach((page, p) => {
    const text = [
      'BT',
      ...(p === 0
        ? ['/F2 15 Tf', '50 790 Td', `(${esc(title)}) Tj`, '/F1 10 Tf', '0 -26 Td']
        : ['/F1 10 Tf', '50 790 Td']),
      '14 TL',
      ...page.map((l) => `(${esc(l)}) Tj T*`),
      'ET',
      'BT /F1 8 Tf 50 30 Td',
      `(Page ${p + 1} of ${pages.length}) Tj`,
      'ET',
    ].join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(text, 'latin1')} >>\nstream\n${text}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  });
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
