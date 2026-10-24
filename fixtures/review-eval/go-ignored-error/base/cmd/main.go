package main

import (
	"fmt"

	"example.test/shop/report"
)

func main() {
	snap := report.Build(map[string][]string{"api": {"a", "b"}, "web": {"c"}})
	fmt.Println("findings:", snap.Total)
}
