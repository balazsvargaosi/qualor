from shop.orders import order_total


def invoice_amount(order):
    return order_total(order["lines"])
