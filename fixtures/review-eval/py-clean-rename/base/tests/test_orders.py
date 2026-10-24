from shop.orders import calc_total, describe

LINES = [
    {"price_cents": 250, "quantity": 2},
    {"price_cents": 100, "quantity": 1},
]


def test_calc_total_adds_the_lines():
    assert calc_total(LINES) == 600


def test_describe_names_the_total():
    assert describe({"id": "A1", "lines": LINES}) == "A1: 600 cents"
