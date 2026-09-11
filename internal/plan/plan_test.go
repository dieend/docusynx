package plan

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/dieend/docusynx/pkg/bundle"
	"github.com/dieend/docusynx/pkg/target"
)

func TestBuildIsDeterministic(t *testing.T) {
	doc := bundle.Document{ID: "a", Title: "A", Route: "/a", Source: bundle.Source{Path: "a.md"}, Blocks: []json.RawMessage{json.RawMessage(`{"type":"paragraph","inlines":[]}`)}}
	hash, err := doc.CalculateHash()
	if err != nil {
		t.Fatal(err)
	}
	doc.Hash = hash
	b := &bundle.Bundle{Hash: "sha256:bundle", Documents: []bundle.Document{doc}}
	remote := []target.RemoteDocument{{ID: "2", Title: "old", Version: 1, Metadata: target.ManagedMetadata{Namespace: "n", DocumentID: "a", PageVersion: 1}}, {ID: "1", Title: "removed", Version: 1, Metadata: target.ManagedMetadata{Namespace: "n", DocumentID: "z", PageVersion: 1}}}
	first, err := Build("p", "t", "n", "bundle.json", b, remote)
	if err != nil {
		t.Fatal(err)
	}
	remote[0], remote[1] = remote[1], remote[0]
	second, err := Build("p", "t", "n", "bundle.json", b, remote)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("plans differ:\n%+v\n%+v", first, second)
	}
}
