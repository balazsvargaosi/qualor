package dev.example.shop;

import java.util.Optional;

public final class UserService {
    private final UserRepository users;

    public UserService(UserRepository users) {
        this.users = users;
    }

    public boolean exists(long userId) {
        return users.findById(userId).isPresent();
    }

    public String displayName(long userId) {
        Optional<User> user = users.findById(userId);
        return user.get().name();
    }
}
