package collect

import "github.com/thisisjun786/ocx-quota-manager/internal/contract"

// LocalCLI is a credential source outside OCX: the login file a vendor's own
// CLI keeps under the user's home. It yields the same Binding an OCX account
// does, so the scheduler, the observation store and the analytics treat it no
// differently. Source names the file in Binding.Source and Local.Files; the
// token stays in memory like every other credential.
//
// A source is read only while its provider is named in QUOTA_DIRECT_PROVIDERS,
// so an install that does not opt in neither opens the file nor publishes the
// provider. The file is only ever read: renewing an expired login is the CLI's
// job, and until it does the provider answers 401 like any refused credential.
type LocalCLI struct {
	Provider  string // provider key, shared with the adapter and native usage
	Source    string // Binding.Source and Local.Files key
	AccountID string // one login per CLI home
	Label     string
	Hint      string // what the user can do when the file cannot be read
	Path      func(Reader) string
	// Parse returns the login a decoded file holds; ok is false when the file
	// decoded but carries no usable token.
	Parse func(obj map[string]any) (login LocalLogin, ok bool)
}

// LocalLogin is what a LocalCLI file contributes to a Binding.
type LocalLogin struct {
	Token string
	// AccountRef is the vendor's stable account identity. Access tokens rotate
	// hourly; without a reference every rotation would open a new identity
	// epoch and split the window's history.
	AccountRef *string
}

// LocalCLIs lists the registered local CLI sources. Adding a tool is one entry
// here plus its adapter, its parser and its provider id in RegisteredDirect.
var LocalCLIs = []LocalCLI{antigravityCLI}

func localCLI(source string) (LocalCLI, bool) {
	for _, cli := range LocalCLIs {
		if cli.Source == source {
			return cli, true
		}
	}
	return LocalCLI{}, false
}

// projectLocalCLI adds the CLI's account to its provider and, when the file
// holds a token, its binding. A missing or unusable file is an account that
// needs a new login, never a failed collection.
func projectLocalCLI(out Local, cli LocalCLI, obj map[string]any, nowMS int64) Local {
	login, ok := LocalLogin{}, false
	if obj != nil {
		if login, ok = cli.Parse(obj); !ok || login.Token == "" {
			ok = false
			out.Files[cli.Source] = FileMalformed
			out.Warnings = append(out.Warnings, warningFor(cli.Source))
		}
	}
	acc := projectQuotaAccount(cli.AccountID, cli.Label, nil, ok, nil, nowMS, accountState{Reauth: !ok})
	if ok {
		out.Bindings = append(out.Bindings, Binding{
			Provider: cli.Provider, AccountID: cli.AccountID, Kind: KindOAuth, Token: login.Token,
			AccountRef: login.AccountRef, Enabled: true, Source: cli.Source,
		})
	}
	for i := range out.Providers {
		if out.Providers[i].ID == cli.Provider {
			out.Providers[i].Accounts = append(out.Providers[i].Accounts, acc)
			return out
		}
	}
	name := providerNames[cli.Provider]
	if name == "" {
		name = cli.Provider
	}
	out.Providers = append(out.Providers, contract.Provider{
		ID: cli.Provider, Name: name, Enabled: true, SupportedModels: []string{}, Accounts: []contract.Account{acc},
	})
	return out
}
