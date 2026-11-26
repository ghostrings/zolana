/** An address as a QR code, drawn as one SVG path. Black on nothing: whatever holds it supplies the white. */

import qrcode from 'qrcode-generator';

export function qrSvg(text: string): string {
  const code = qrcode(0, 'M');
  code.addData(text, 'Byte');
  code.make();
  const size = code.getModuleCount();
  let path = '';
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; ) {
      if (!code.isDark(row, column)) {
        column += 1;
        continue;
      }
      let end = column;
      while (end < size && code.isDark(row, end)) end += 1;
      path += `M${column} ${row}h${end - column}v1h-${end - column}z`;
      column = end;
    }
  }
  return `<svg viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" aria-hidden="true"><path fill="#000" d="${path}"/></svg>`;
}
