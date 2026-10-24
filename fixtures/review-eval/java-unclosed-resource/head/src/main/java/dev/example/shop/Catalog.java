package dev.example.shop;

import java.io.IOException;
import java.util.Map;

public final class Catalog {
    private final Map<String, Integer> prices;

    public Catalog(Map<String, Integer> prices) {
        this.prices = prices;
    }

    public static Catalog fromFile(String path) throws IOException {
        return new Catalog(PriceList.load(path));
    }

    public int priceOf(String sku) {
        Integer price = prices.get(sku);
        if (price == null) {
            throw new IllegalArgumentException("unknown sku " + sku);
        }
        return price;
    }
}
