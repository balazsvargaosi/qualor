import { formatCents } from './format';

export interface InvoiceRow {
  description: string;
  amountCents: number;
}

export function renderInvoiceRow(row: InvoiceRow): string {
  return `${row.description}: ${formatCents(row.amountCents)} EUR`;
}
