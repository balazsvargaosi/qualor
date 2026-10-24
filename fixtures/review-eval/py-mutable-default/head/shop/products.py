def make_product(name, price_cents):
    return {"name": name, "price_cents": price_cents}


def with_tag(product, tag, tags=[]):
    tags.append(tag)
    return {**product, "tags": tags}
