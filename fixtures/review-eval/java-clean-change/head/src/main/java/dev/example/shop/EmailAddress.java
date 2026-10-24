package dev.example.shop;

import java.util.Locale;

public final class EmailAddress {
    private EmailAddress() {}

    /** The address without surrounding blanks and in lower case; null stays null. */
    public static String normalise(String address) {
        if (address == null) {
            return null;
        }
        return address.trim().toLowerCase(Locale.ROOT);
    }
}
