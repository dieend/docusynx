package bundle

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestDocumentHashMatchesExporterCanonicalJSON(t *testing.T) {
	document := Document{ID: "a", Title: "A", Route: "/a", Source: Source{Path: "a.md"}, Blocks: []json.RawMessage{json.RawMessage(`{"type":"code","value":"<tag>"}`)}}
	got, err := document.CalculateHash()
	if err != nil {
		t.Fatal(err)
	}
	const want = "sha256:40fd3a7c8b1942574352c8268d279c7e626cfd1534450bbd2cedc69a3d061c59"
	if got != want {
		t.Fatalf("hash=%s, want %s", got, want)
	}
}

func TestCanonicalHashVectors(t *testing.T) {
	tests := []struct {
		name  string
		value any
		want  string
	}{
		{"html unicode separators", map[string]any{"text": "<&> café \u2028 \u2029"}, "sha256:cf7dc1fe1aa65d5813931535d28d7261c7b976628a369155b2d6a213d139af81"},
		{"nested empty and numbers", map[string]any{"nested": map[string]any{"z": 2, "a": []any{0, 1.5, -2}}, "empty": "", "enabled": false}, "sha256:855ca5e5ecc3002f638cda112895fd1fbf2634ab74901ca3cba8da7882e17520"},
		{"blocks and empty optional", map[string]any{"blocks": []any{map[string]any{"type": "code", "value": "<&>"}}, "order": 0, "parentId": ""}, "sha256:f6142c45c7db2a8c0bb559a17678b3137e624f6ea23dec28ea8c6a037432613b"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, hashErr := hashJSON(test.value)
			if hashErr != nil {
				t.Fatal(hashErr)
			}
			if got != test.want {
				t.Fatalf("hash=%s, want %s", got, test.want)
			}
		})
	}
}

func TestValidateRejectsEscapingAssetPath(t *testing.T) {
	const hash = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	b := &Bundle{SchemaVersion: 1, Site: Site{Name: "x", BaseURL: "https://example.com"}, Documents: []Document{{ID: "a", Title: "A", Route: "/a", Source: Source{Path: "a.md"}, Blocks: []json.RawMessage{json.RawMessage(`{"type":"paragraph","inlines":[]}`)}}}, Assets: []Asset{{ID: hash, Path: "../secret", MIMEType: "text/plain", Hash: hash}}}
	sealTestBundle(t, b)
	if err := b.Validate(); err == nil {
		t.Fatal("expected asset path error")
	}
}

func TestValidateRejectsUnsupportedAndBrokenReferences(t *testing.T) {
	tests := []json.RawMessage{
		json.RawMessage(`{"type":"extension","name":"html","data":{}}`),
		json.RawMessage(`{"type":"paragraph","inlines":[{"type":"link","target":{"kind":"document","value":"missing"},"children":[]}]}`),
		json.RawMessage(`{"type":"image","assetId":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}`),
		json.RawMessage(`{"type":"paragraph","inlines":[{"type":"link","target":{"kind":"url","value":"../relative"},"children":[]}]}`),
	}
	for _, block := range tests {
		b := &Bundle{SchemaVersion: 1, Site: Site{Name: "x", BaseURL: "https://example.com"}, Documents: []Document{{ID: "a", Title: "A", Route: "/a", Source: Source{Path: "a.md"}, Blocks: []json.RawMessage{block}}}, Assets: []Asset{}}
		sealTestBundle(t, b)
		if err := b.Validate(); err == nil {
			t.Errorf("expected validation error for %s", block)
		}
	}
}

func TestValidateFilesChecksContentHash(t *testing.T) {
	directory := t.TempDir()
	content := []byte("asset")
	if err := os.WriteFile(filepath.Join(directory, "asset.txt"), content, 0o600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(content)
	hash := "sha256:" + hex.EncodeToString(sum[:])
	block := json.RawMessage(fmt.Sprintf(`{"type":"image","assetId":%q}`, hash))
	b := &Bundle{SchemaVersion: 1, Site: Site{Name: "x", BaseURL: "https://example.com"}, Documents: []Document{{ID: "a", Title: "A", Route: "/a", Source: Source{Path: "a.md"}, Blocks: []json.RawMessage{block}}}, Assets: []Asset{{ID: hash, Path: "asset.txt", MIMEType: "text/plain", Hash: hash}}}
	sealTestBundle(t, b)
	if err := b.Validate(); err != nil {
		t.Fatal(err)
	}
	if err := b.ValidateFiles(filepath.Join(directory, "manifest.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "asset.txt"), []byte("changed"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := b.ValidateFiles(filepath.Join(directory, "manifest.json")); err == nil {
		t.Fatal("expected content hash mismatch")
	}
}

func TestValidateRejectsUnsafeSourceURL(t *testing.T) {
	b := &Bundle{SchemaVersion: 1, Site: Site{Name: "x", BaseURL: "https://example.com"}, Documents: []Document{{ID: "a", Title: "A", Route: "/a", Source: Source{Path: "a.md", URL: "javascript:alert(1)"}, Blocks: []json.RawMessage{json.RawMessage(`{"type":"paragraph","inlines":[]}`)}}}, Assets: []Asset{}}
	sealTestBundle(t, b)
	if validationErr := b.Validate(); validationErr == nil {
		t.Fatal("expected unsafe source URL error")
	}
}

func sealTestBundle(t *testing.T, b *Bundle) {
	t.Helper()
	for i := range b.Documents {
		hash, hashErr := b.Documents[i].CalculateHash()
		if hashErr != nil {
			t.Fatal(hashErr)
		}
		b.Documents[i].Hash = hash
	}
	hash, hashErr := b.CalculateHash()
	if hashErr != nil {
		t.Fatal(hashErr)
	}
	b.Hash = hash
}
