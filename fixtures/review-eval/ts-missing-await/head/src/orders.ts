import { orders, reserveStock, type Order } from './store';

export type PlaceResult = { ok: true } | { ok: false; reason: string };

export async function placeOrder(order: Order): Promise<PlaceResult> {
  try {
    await reserveStock(order.lines);
    orders.save(order);
    return { ok: true };
  } catch (err) {
    console.error('placing the order failed', err);
    return { ok: false, reason: 'order_failed' };
  }
}
