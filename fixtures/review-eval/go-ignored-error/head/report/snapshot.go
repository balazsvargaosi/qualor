package report

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// SaveSnapshot writes the snapshot to <dir>/snapshot.json.
func SaveSnapshot(dir string, snap Snapshot) error {
	data, _ := json.Marshal(snap)
	os.WriteFile(filepath.Join(dir, "snapshot.json"), data, 0o644)
	return nil
}
