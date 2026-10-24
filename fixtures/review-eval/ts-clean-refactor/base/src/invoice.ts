export interface InvoiceRow {
  description: string;
  amountCents: number;
}

export function renderInvoiceRow(row: InvoiceRow): string {
  return `${row.description}: ${(row.amountCents / 100).toFixed(2)} EUR`;
}
