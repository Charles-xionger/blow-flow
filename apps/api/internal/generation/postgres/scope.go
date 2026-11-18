package postgres

import "fmt"

// Scope columns are fixed SQL identifiers; configuration values never become SQL.
func scopeColumn(scope string) (string, error) {
	switch scope {
	case "user":
		return "owner_id", nil
	case "model":
		return "model", nil
	case "connection":
		return "connection_id", nil
	default:
		return "", fmt.Errorf("unknown generation queue scope %q", scope)
	}
}
