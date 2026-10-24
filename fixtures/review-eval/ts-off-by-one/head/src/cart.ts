export interface CartItem {
  sku: string;
  priceCents: number;
  quantity: number;
}

export function lineTotal(item: CartItem): number {
  return item.priceCents * item.quantity;
}

export function cartTotal(items: CartItem[]): number {
  let total = 0;
  for (let i = 0; i <= items.length; i++) {
    total += lineTotal(items[i]);
  }
  return total;
}
