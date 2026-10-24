package dev.example.shop;

import java.util.Optional;

public interface UserRepository {
    /** The user with this id, or empty when there is none. */
    Optional<User> findById(long id);
}
