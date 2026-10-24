from shop.products import make_product, with_tag


def test_make_product_keeps_name_and_price():
    product = make_product("mug", 899)
    assert product == {"name": "mug", "price_cents": 899}


def test_with_tag_adds_the_tag():
    product = make_product("mug", 899)
    assert with_tag(product, "sale")["tags"] == ["sale"]
