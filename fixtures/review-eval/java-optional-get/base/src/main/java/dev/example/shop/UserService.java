package dev.example.shop;

public final class UserService {
    private final UserRepository users;

    public UserService(UserRepository users) {
        this.users = users;
    }

    public boolean exists(long userId) {
        return users.findById(userId).isPresent();
    }
}
