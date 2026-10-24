export interface Order {
  id: string;
  lines: { sku: string; quantity: number }[];
}

export const orders = {
  async save(order: Order): Promise<void> {
    await writeRow('orders', order.id, JSON.stringify(order));
  },
};

export async function reserveStock(lines: Order['lines']): Promise<void> {
  for (const line of lines) {
    await writeRow('stock', line.sku, String(-line.quantity));
  }
}

async function writeRow(table: string, key: string, value: string): Promise<void> {
  const response = await fetch(`http://localhost:8080/${table}/${key}`, {
    method: 'PUT',
    body: value,
  });
  if (!response.ok) {
    throw new Error(`write to ${table} failed with ${response.status}`);
  }
}
