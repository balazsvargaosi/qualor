package dev.example.shop;

import java.io.BufferedReader;
import java.io.FileReader;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;

/** Reads the price list: one "sku;price in cents" pair on each line. */
public final class PriceList {
    private PriceList() {}

    public static Map<String, Integer> load(String path) throws IOException {
        BufferedReader reader = new BufferedReader(new FileReader(path));
        Map<String, Integer> prices = new HashMap<>();
        String line;
        while ((line = reader.readLine()) != null) {
            String[] parts = line.split(";");
            prices.put(parts[0], Integer.parseInt(parts[1]));
        }
        return prices;
    }
}
