def order_total(lines):
    """The order's total in cents."""
    return sum(line["price_cents"] * line["quantity"] for line in lines)


def describe(order):
    return f"{order['id']}: {order_total(order['lines'])} cents"
