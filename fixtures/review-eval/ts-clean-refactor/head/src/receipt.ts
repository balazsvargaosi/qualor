import { formatCents } from './format';

export interface ReceiptLine {
  name: string;
  priceCents: number;
  quantity: number;
}

export function renderReceipt(lines: ReceiptLine[]): string {
  const rows = lines.map((line) => {
    const price = formatCents(line.priceCents);
    const total = formatCents(line.priceCents * line.quantity);
    return `${line.name} x${line.quantity} @ ${price} = ${total}`;
  });
  const sum = lines.reduce((acc, line) => acc + line.priceCents * line.quantity, 0);
  rows.push(`TOTAL ${formatCents(sum)}`);
  return rows.join('\n');
}
