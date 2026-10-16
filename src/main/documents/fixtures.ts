/** Synthetic, self-contained PDF fixture. No reference assets, fonts or user documents. */
export function syntheticPdf(lines: readonly string[] = [
  'CS2041 Assignment 3 (synthetic)', 'Tasks: adjacency lists, DFS, BFS and Dijkstra.',
  'Submission: PDF report and source ZIP.', 'Deadline: 2026-10-24 23:59',
  'RAW_ONLY_ATTACHMENT_PDF', 'API key: sk-syntheticdocumentcanary1234567890',
]): Uint8Array {
  const literal = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
  const content = ['BT /F1 12 Tf 50 760 Td', ...lines.flatMap((line, i) => [...(i ? ['0 -20 Td'] : []), '(' + literal(line) + ') Tj']), 'ET'].join('\n')
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Length ' + Buffer.byteLength(content) + ' >>\nstream\n' + content + '\nendstream']
  let pdf = '%PDF-1.4\n'; const offsets = [0]
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(pdf)
  pdf += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n').join('')
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(pdf))
}
export function documentFixture(id: 'assignment-pdf' | 'notes-text' | 'malformed-pdf' | 'scanned-pdf') {
  return id === 'notes-text' ? { format: 'text' as const, bytes: new Uint8Array(Buffer.from('SYNTHETIC_NOTES\nGraph traversal checklist\nRAW_ONLY_DROPPED_FILE\nDeadline: 2026-10-24 23:59\nEmail: fixture@example.invalid\nAPI key: sk-syntheticfilefixture1234567890')) }
    : { format: 'pdf' as const, bytes: id === 'malformed-pdf' ? new Uint8Array(Buffer.from('%PDF-1.4\nmalformed')) : syntheticPdf(id === 'scanned-pdf' ? [] : undefined) }
}
