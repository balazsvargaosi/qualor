package words

import (
	"strings"
	"sync"
)

// CountWords returns how often each word occurs in the documents.
func CountWords(docs []string) map[string]int {
	counts := make(map[string]int)
	var wg sync.WaitGroup
	for _, doc := range docs {
		wg.Add(1)
		go func(text string) {
			defer wg.Done()
			for _, word := range strings.Fields(text) {
				counts[word]++
			}
		}(doc)
	}
	wg.Wait()
	return counts
}
