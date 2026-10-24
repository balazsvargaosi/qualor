import type { CartItem } from './cart';

export interface Summary {
  itemCount: number;
}

export function summarise(items: CartItem[]): Summary {
  return { itemCount: items.length };
}
