package dev.example.shop;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class UserDirectoryTest {
    private final UserDirectory directory = new UserDirectory();

    @Test
    void findsAUserWhateverTheCaseOfTheAddress() {
        User ann = new User("Ann", "Ann@Example.com");
        directory.add(ann);

        assertEquals(ann, directory.find("ann@example.com").orElseThrow());
        assertEquals(ann, directory.find("ANN@EXAMPLE.COM").orElseThrow());
    }

    @Test
    void ignoresBlanksAroundTheAddress() {
        User ann = new User("Ann", "ann@example.com");
        directory.add(ann);

        assertEquals(ann, directory.find("  ann@example.com ").orElseThrow());
    }

    @Test
    void findsNobodyForAnAddressThatIsNotThere() {
        directory.add(new User("Ann", "ann@example.com"));

        assertTrue(directory.find("bob@example.com").isEmpty());
        assertTrue(directory.find(null).isEmpty());
    }
}
