package calc

import "math"

// NeededAccounts is the independent quota-account formula locked in JUN-259:
// ceil(stable(sumPp/100 * capacityHours / periodHours)).
// weekly capacityHours=168, monthly=720. No USD inversion, no headroom.
func NeededAccounts(sumPp, capacityHours, periodHours float64) int {
	if periodHours <= 0 || capacityHours <= 0 {
		return 0
	}
	raw := sumPp / 100 * capacityHours / periodHours
	nearest := math.Round(raw)
	eps := math.Nextafter(1, 2) - 1
	stable := raw
	if nearest > 0 && math.Abs(raw-nearest) <= eps*math.Max(1, raw)*8 {
		stable = nearest
	}
	return int(math.Ceil(stable))
}
