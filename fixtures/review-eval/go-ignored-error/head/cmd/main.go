package main

import (
	"fmt"
	"os"

	"example.test/shop/report"
)

func main() {
	snap := report.Build(map[string][]string{"api": {"a", "b"}, "web": {"c"}})
	fmt.Println("findings:", snap.Total)
	if err := report.SaveSnapshot(os.TempDir(), snap); err != nil {
		fmt.Println("could not save the snapshot:", err)
		os.Exit(1)
	}
}
