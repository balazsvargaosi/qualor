export interface ReceiptLine {
  name: string;
  priceCents: number;
  quantity: number;
}

export function renderReceipt(lines: ReceiptLine[]): string {
  const rows = lines.map((line) => {
    const price = (line.priceCents / 100).toFixed(2);
    const total = ((line.priceCents * line.quantity) / 100).toFixed(2);
    return `${line.name} x${line.quantity} @ ${price} = ${total}`;
  });
  const sum = lines.reduce((acc, line) => acc + line.priceCents * line.quantity, 0);
  rows.push(`TOTAL ${(sum / 100).toFixed(2)}`);
  return rows.join('\n');
}
