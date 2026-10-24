package dev.example.shop;

import java.util.Map;

public final class Catalog {
    private final Map<String, Integer> prices;

    public Catalog(Map<String, Integer> prices) {
        this.prices = prices;
    }

    public int priceOf(String sku) {
        Integer price = prices.get(sku);
        if (price == null) {
            throw new IllegalArgumentException("unknown sku " + sku);
        }
        return price;
    }
}
