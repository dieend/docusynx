package confluence

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"github.com/dieend/docusynx/internal/engine"
	"github.com/dieend/docusynx/pkg/bundle"
	"github.com/dieend/docusynx/pkg/target"
)

func TestLiveConfluenceAcceptance(t *testing.T) {
	names := []string{"DOCUSYNX_TEST_CONFLUENCE_BASE_URL", "DOCUSYNX_TEST_CONFLUENCE_EMAIL", "DOCUSYNX_TEST_CONFLUENCE_API_TOKEN", "DOCUSYNX_TEST_CONFLUENCE_SPACE_ID", "DOCUSYNX_TEST_CONFLUENCE_ROOT_PAGE_ID"}
	values := map[string]string{}
	for _, name := range names {
		values[name] = os.Getenv(name)
		if values[name] == "" {
			t.Skip("live Confluence acceptance credentials are not set")
		}
	}
	client, clientErr := New(Options{BaseURL: values[names[0]], Email: values[names[1]], APIToken: values[names[2]]})
	if clientErr != nil {
		t.Fatal(clientErr)
	}
	ctx := context.Background()
	namespace := "docusynx-live-" + time.Now().UTC().Format("20060102T150405.000000000")
	scope := target.Scope{Namespace: namespace, SpaceID: values[names[3]], RootPageID: values[names[4]]}
	core := engine.Engine{Target: client}
	keep := os.Getenv("DOCUSYNX_TEST_CONFLUENCE_KEEP") == "true"
	if !keep {
		t.Cleanup(func() {
			for {
				remote, discoverErr := client.Discover(ctx, scope)
				if discoverErr != nil || len(remote) == 0 {
					return
				}
				sort.Slice(remote, func(i, j int) bool {
					return remote[i].Metadata.ParentDocument != "" && remote[j].Metadata.ParentDocument == ""
				})
				if deleteErr := client.Delete(ctx, scope, remote[0]); deleteErr != nil {
					return
				}
			}
		})
	}
	directory := t.TempDir()
	assetPath := filepath.Join(directory, "diagram.svg")
	assetBytes := []byte(`<svg xmlns="http://www.w3.org/2000/svg"><text>docusynx</text></svg>`)
	if writeErr := os.WriteFile(assetPath, assetBytes, 0o600); writeErr != nil {
		t.Fatal(writeErr)
	}
	sum := sha256.Sum256(assetBytes)
	assetID := "sha256:" + hex.EncodeToString(sum[:])
	bundlePath := filepath.Join(directory, "manifest.json")
	initial := liveBundle(namespace, assetID, false)
	initial.Assets = []bundle.Asset{{ID: assetID, Path: "diagram.svg", MIMEType: "image/svg+xml", Hash: assetID}}
	sealBundle(t, initial)
	if validationErr := initial.Validate(); validationErr != nil {
		t.Fatal(validationErr)
	}
	createPlan, planErr := core.Plan(ctx, "live", "confluence", namespace, bundlePath, initial, scope)
	if planErr != nil {
		t.Fatal(planErr)
	}
	if len(createPlan.Operations) != 2 {
		t.Fatalf("create operations=%+v", createPlan.Operations)
	}
	if applyErr := core.Apply(ctx, createPlan, initial, scope, ""); applyErr != nil {
		t.Fatal(applyErr)
	}
	noOpPlan, planErr := core.Plan(ctx, "live", "confluence", namespace, bundlePath, initial, scope)
	if planErr != nil {
		t.Fatal(planErr)
	}
	if len(noOpPlan.Operations) != 0 {
		t.Fatalf("second plan=%+v", noOpPlan.Operations)
	}
	remote, discoverErr := client.Discover(ctx, scope)
	if discoverErr != nil {
		t.Fatal(discoverErr)
	}
	if len(remote) != 2 {
		t.Fatalf("managed pages=%d", len(remote))
	}
	var assetPage target.RemoteDocument
	for _, page := range remote {
		if page.Metadata.DocumentID == "acceptance/asset" {
			assetPage = page
		}
		assertLiveLabels(t, client, page.ID)
	}
	if assetPage.ID == "" {
		t.Fatal("asset page missing")
	}
	var attachments struct {
		Results []struct {
			Title string `json:"title"`
		} `json:"results"`
	}
	if requestErr := client.get(ctx, client.apiV2("/pages/"+assetPage.ID+"/attachments?limit=250"), &attachments); requestErr != nil {
		t.Fatal(requestErr)
	}
	if len(attachments.Results) != 1 {
		t.Fatalf("attachments=%+v", attachments.Results)
	}
	if keep {
		t.Logf("leaving namespace %s with %d managed pages under root page %s", namespace, len(remote), scope.RootPageID)
		return
	}
	if uploadErr := client.UploadAsset(ctx, assetPage, target.Asset{ID: assetID, Path: assetPath, Filename: attachments.Results[0].Title, Hash: "sha256:acceptance-drift", MIMEType: "image/svg+xml"}); uploadErr != nil {
		t.Fatal(uploadErr)
	}
	changed := liveBundle(namespace, assetID, true)
	changed.Assets = initial.Assets
	sealBundle(t, changed)
	if validationErr := changed.Validate(); validationErr != nil {
		t.Fatal(validationErr)
	}
	updatePlan, planErr := core.Plan(ctx, "live", "confluence", namespace, bundlePath, changed, scope)
	if planErr != nil {
		t.Fatal(planErr)
	}
	if len(updatePlan.Operations) != 1 || updatePlan.Operations[0].Type != "update" {
		t.Fatalf("update operations=%+v", updatePlan.Operations)
	}
	if applyErr := core.Apply(ctx, updatePlan, changed, scope, ""); applyErr != nil {
		t.Fatal(applyErr)
	}
	empty := &bundle.Bundle{SchemaVersion: 1, Site: bundle.Site{Name: "Acceptance", BaseURL: "https://example.invalid"}, Documents: []bundle.Document{}, Assets: []bundle.Asset{}}
	sealBundle(t, empty)
	if validationErr := empty.Validate(); validationErr != nil {
		t.Fatal(validationErr)
	}
	deletePlan, planErr := core.Plan(ctx, "live", "confluence", namespace, bundlePath, empty, scope)
	if planErr != nil {
		t.Fatal(planErr)
	}
	if len(deletePlan.Operations) != 2 {
		t.Fatalf("delete operations=%+v", deletePlan.Operations)
	}
	if applyErr := core.Apply(ctx, deletePlan, empty, scope, ""); applyErr != nil {
		t.Fatal(applyErr)
	}
	remote, discoverErr = client.Discover(ctx, scope)
	if discoverErr != nil {
		t.Fatal(discoverErr)
	}
	if len(remote) != 0 {
		t.Fatalf("pages remain: %+v", remote)
	}
}

func liveBundle(namespace, assetID string, changed bool) *bundle.Bundle {
	text := "initial"
	if changed {
		text = "changed"
	}
	image := json.RawMessage(`{"type":"image","assetId":"` + assetID + `","alt":"acceptance"}`)
	return &bundle.Bundle{SchemaVersion: 1, Site: bundle.Site{Name: "Acceptance", BaseURL: "https://example.invalid"}, Documents: []bundle.Document{{ID: "acceptance", Title: "docusynx acceptance " + namespace, Route: "/acceptance", Source: bundle.Source{Path: "acceptance.md"}, Blocks: []json.RawMessage{json.RawMessage(`{"type":"paragraph","inlines":[{"type":"text","value":"managed root"}]}`)}}, {ID: "acceptance/asset", Title: "Attachment", Route: "/acceptance/asset", ParentID: "acceptance", Order: 1, Source: bundle.Source{Path: "asset.md"}, Blocks: []json.RawMessage{image, json.RawMessage(`{"type":"paragraph","inlines":[{"type":"text","value":"` + text + `"}]}`)}}}, Assets: []bundle.Asset{}}
}

func assertLiveLabels(t *testing.T, client *Client, pageID string) {
	t.Helper()
	var labels struct {
		Results []struct {
			Name string `json:"name"`
		} `json:"results"`
	}
	if requestErr := client.get(context.Background(), client.apiV2("/pages/"+pageID+"/labels?limit=250"), &labels); requestErr != nil {
		t.Fatal(requestErr)
	}
	found := map[string]bool{}
	for _, label := range labels.Results {
		found[label.Name] = true
	}
	if !found["autogenerated"] || !found["docusynx-managed"] {
		t.Fatalf("managed labels missing on %s: %+v", pageID, labels.Results)
	}
}
