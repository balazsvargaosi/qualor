package dev.example.shop;

import java.util.HashMap;
import java.util.Map;
import java.util.Optional;

public final class UserDirectory {
    private final Map<String, User> byEmail = new HashMap<>();

    public void add(User user) {
        byEmail.put(user.email(), user);
    }

    public Optional<User> find(String email) {
        return Optional.ofNullable(byEmail.get(email));
    }
}
