package report

// Snapshot is the report as the next run compares against it.
type Snapshot struct {
	Total    int            `json:"total"`
	ByModule map[string]int `json:"byModule"`
}

// Build counts the findings of each module.
func Build(findings map[string][]string) Snapshot {
	snap := Snapshot{ByModule: make(map[string]int, len(findings))}
	for module, list := range findings {
		snap.ByModule[module] = len(list)
		snap.Total += len(list)
	}
	return snap
}
