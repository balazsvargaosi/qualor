package words

import "strings"

// CountWords returns how often each word occurs in the documents.
func CountWords(docs []string) map[string]int {
	counts := make(map[string]int)
	for _, doc := range docs {
		for _, word := range strings.Fields(doc) {
			counts[word]++
		}
	}
	return counts
}
