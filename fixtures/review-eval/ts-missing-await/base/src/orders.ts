import { orders, reserveStock, type Order } from './store';

export async function placeOrder(order: Order): Promise<void> {
  await reserveStock(order.lines);
  await orders.save(order);
}
