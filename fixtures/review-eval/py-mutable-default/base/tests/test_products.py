from shop.products import make_product


def test_make_product_keeps_name_and_price():
    product = make_product("mug", 899)
    assert product == {"name": "mug", "price_cents": 899}
