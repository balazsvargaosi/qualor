import { cartTotal, type CartItem } from './cart';

export interface Summary {
  itemCount: number;
  totalCents: number;
}

export function summarise(items: CartItem[]): Summary {
  return { itemCount: items.length, totalCents: cartTotal(items) };
}
