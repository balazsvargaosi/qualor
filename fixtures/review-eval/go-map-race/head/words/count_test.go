package words

import "testing"

func TestCountWordsCountsAcrossDocuments(t *testing.T) {
	got := CountWords([]string{"a b a", "b c"})
	want := map[string]int{"a": 2, "b": 2, "c": 1}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for word, n := range want {
		if got[word] != n {
			t.Errorf("%q: got %d, want %d", word, got[word], n)
		}
	}
}
