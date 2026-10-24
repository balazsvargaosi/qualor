package batch

import (
	"reflect"
	"testing"
)

func TestChunk(t *testing.T) {
	tests := []struct {
		name  string
		items []int
		size  int
		want  [][]int
	}{
		{"empty", nil, 3, nil},
		{"fewer than one chunk", []int{1, 2}, 3, [][]int{{1, 2}}},
		{"exactly one chunk", []int{1, 2, 3}, 3, [][]int{{1, 2, 3}}},
		{"a short last chunk", []int{1, 2, 3, 4, 5}, 2, [][]int{{1, 2}, {3, 4}, {5}}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := Chunk(tc.items, tc.size); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestChunkPanicsOnASizeThatIsNotPositive(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("expected a panic")
		}
	}()
	Chunk([]int{1}, 0)
}

func TestChunkAppendDoesNotOverwriteTheNextChunk(t *testing.T) {
	chunks := Chunk([]int{1, 2, 3, 4}, 2)
	_ = append(chunks[0], 99)
	if chunks[1][0] != 3 {
		t.Errorf("the next chunk was overwritten: %v", chunks[1])
	}
}
