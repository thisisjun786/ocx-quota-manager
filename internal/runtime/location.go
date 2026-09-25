package runtime

import (
	"os"
	"time"
)

// displayLocation sets the day boundary of the daily cost series. QUOTA_TZ
// overrides the process zone; an unknown name falls back to it.
var displayLocation = func() *time.Location {
	if name := os.Getenv("QUOTA_TZ"); name != "" {
		if loc, err := time.LoadLocation(name); err == nil {
			return loc
		}
	}
	return time.Local
}()
