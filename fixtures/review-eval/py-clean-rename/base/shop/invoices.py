from shop.orders import calc_total


def invoice_amount(order):
    return calc_total(order["lines"])
