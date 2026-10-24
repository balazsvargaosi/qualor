package batch

// Chunk splits items into consecutive slices of at most size elements. The slices share items'
// memory, and appending to one never overwrites the next. It panics if size is not positive.
func Chunk[T any](items []T, size int) [][]T {
	if size <= 0 {
		panic("batch.Chunk: size must be positive")
	}
	var chunks [][]T
	for len(items) > 0 {
		n := min(size, len(items))
		chunks = append(chunks, items[:n:n])
		items = items[n:]
	}
	return chunks
}
