package oidc

import "testing"

func TestSelectedProviderProfileMapsMFAClaims(t *testing.T) {
	profile := Profile{MFAAuthenticationMethod: "provider-mfa", MFAAssuranceContext: "urn:provider:loa:2"}
	for _, test := range []struct {
		name    string
		methods []string
		acr     string
		want    bool
	}{
		{name: "configured amr", methods: []string{"pwd", "provider-mfa"}, want: true},
		{name: "configured acr", methods: []string{"pwd"}, acr: "urn:provider:loa:2", want: true},
		{name: "unmapped provider claim", methods: []string{"mfa"}, acr: "other", want: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := profile.provesMFA(test.methods, test.acr); got != test.want {
				t.Fatalf("provesMFA() = %v, want %v", got, test.want)
			}
		})
	}
}
