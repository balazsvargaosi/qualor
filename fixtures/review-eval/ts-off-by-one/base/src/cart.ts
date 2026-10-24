export interface CartItem {
  sku: string;
  priceCents: number;
  quantity: number;
}

export function lineTotal(item: CartItem): number {
  return item.priceCents * item.quantity;
}
