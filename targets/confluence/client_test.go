package confluence

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/dieend/docusynx/internal/engine"
	"github.com/dieend/docusynx/pkg/bundle"
	"github.com/dieend/docusynx/pkg/target"
)

type fakeConfluence struct {
	t                 *testing.T
	mu                sync.Mutex
	next              int
	pages             map[string]page
	properties        map[string]property
	bodies            map[string]string
	labels            map[string]map[string]bool
	attachments       map[string]map[string]struct{ ID, Hash string }
	uploads           int
	dropCreateOnce    bool
	failLabelRequests int
}

func newFake(t *testing.T) *fakeConfluence {
	return &fakeConfluence{t: t, next: 100, pages: map[string]page{}, properties: map[string]property{}, bodies: map[string]string{}, labels: map[string]map[string]bool{}, attachments: map[string]map[string]struct{ ID, Hash string }{}}
}

func (f *fakeConfluence) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	user, password, ok := r.BasicAuth()
	if !ok || user != "test@example.com" || password != "token" {
		f.t.Errorf("bad auth")
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	path := r.URL.Path
	switch {
	case r.Method == http.MethodGet && path == "/wiki/api/v2/spaces/space/pages":
		if r.URL.Query().Get("limit") != "250" {
			f.t.Errorf("missing limit")
		}
		results := make([]page, 0, len(f.pages))
		for _, p := range f.pages {
			results = append(results, p)
		}
		sort.Slice(results, func(i, j int) bool { return results[i].ID < results[j].ID })
		json.NewEncoder(w).Encode(map[string]any{"results": results, "_links": map[string]string{"next": ""}})
	case r.Method == http.MethodGet && strings.HasSuffix(path, "/properties"):
		id := strings.Split(path, "/")[5]
		p, ok := f.properties[id]
		results := []property{}
		if ok {
			results = append(results, p)
		}
		json.NewEncoder(w).Encode(map[string]any{"results": results, "_links": map[string]string{"next": ""}})
	case r.Method == http.MethodGet && strings.HasSuffix(path, "/attachments"):
		id := strings.Split(path, "/")[5]
		results := []map[string]any{}
		for name, attachment := range f.attachments[id] {
			results = append(results, map[string]any{"id": attachment.ID, "title": name, "comment": attachment.Hash})
		}
		json.NewEncoder(w).Encode(map[string]any{"results": results, "_links": map[string]string{"next": ""}})
	case r.Method == http.MethodGet && strings.HasPrefix(path, "/wiki/api/v2/pages/"):
		id := strings.Split(path, "/")[5]
		p, ok := f.pages[id]
		if !ok {
			http.Error(w, "missing", http.StatusNotFound)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"id": p.ID, "title": p.Title, "parentId": p.ParentID, "version": p.Version, "body": map[string]any{"storage": map[string]string{"value": f.bodies[id]}}})
	case r.Method == http.MethodPost && path == "/wiki/api/v2/pages":
		var input struct {
			Title, ParentID string
			Body            struct{ Value string }
		}
		mustDecode(f.t, r, &input)
		f.next++
		id := fmt.Sprint(f.next)
		p := page{ID: id, Title: input.Title, ParentID: input.ParentID}
		p.Version.Number = 1
		f.pages[id] = p
		f.bodies[id] = input.Body.Value
		if f.dropCreateOnce {
			f.dropCreateOnce = false
			panic(http.ErrAbortHandler)
		}
		w.WriteHeader(200)
		json.NewEncoder(w).Encode(p)
	case r.Method == http.MethodPost && strings.HasSuffix(path, "/properties"):
		id := strings.Split(path, "/")[5]
		var input struct {
			Key   string
			Value target.ManagedMetadata
		}
		mustDecode(f.t, r, &input)
		if input.Key != propertyKey {
			f.t.Errorf("bad property key")
		}
		p := property{ID: "property-" + id, Key: input.Key, Value: input.Value}
		p.Version.Number = 1
		f.properties[id] = p
		json.NewEncoder(w).Encode(p)
	case r.Method == http.MethodPost && strings.HasSuffix(path, "/label"):
		if f.failLabelRequests > 0 {
			f.failLabelRequests--
			http.Error(w, "transient", http.StatusServiceUnavailable)
			return
		}
		id := strings.Split(path, "/")[5]
		var input []map[string]string
		mustDecode(f.t, r, &input)
		if f.labels[id] == nil {
			f.labels[id] = map[string]bool{}
		}
		for _, v := range input {
			f.labels[id][v["name"]] = true
		}
		json.NewEncoder(w).Encode(input)
	case r.Method == http.MethodPost && strings.Contains(path, "/child/attachment"):
		id := strings.Split(path, "/")[5]
		if r.Header.Get("X-Atlassian-Token") != "nocheck" {
			f.t.Errorf("missing attachment CSRF header")
		}
		if parseErr := r.ParseMultipartForm(1 << 20); parseErr != nil {
			f.t.Fatal(parseErr)
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			f.t.Fatal(err)
		}
		if header.Header.Get("Content-Type") != "image/svg+xml" {
			f.t.Errorf("asset content type=%q", header.Header.Get("Content-Type"))
		}
		file.Close()
		if f.attachments[id] == nil {
			f.attachments[id] = map[string]struct{ ID, Hash string }{}
		}
		attachmentID := "attachment-" + id
		parts := strings.Split(path, "/")
		if strings.HasSuffix(path, "/data") {
			attachmentID = parts[len(parts)-2]
		}
		f.attachments[id][header.Filename] = struct{ ID, Hash string }{attachmentID, r.FormValue("comment")}
		f.uploads++
		json.NewEncoder(w).Encode(map[string]any{"results": []any{}})
	case r.Method == http.MethodPut && strings.HasPrefix(path, "/wiki/api/v2/pages/") && !strings.Contains(path, "/properties/"):
		id := strings.Split(path, "/")[5]
		old, ok := f.pages[id]
		if !ok {
			http.Error(w, "missing", 404)
			return
		}
		var input struct {
			Title, ParentID string
			Body            struct{ Value string }
			Version         struct{ Number int }
		}
		mustDecode(f.t, r, &input)
		if input.Version.Number != old.Version.Number+1 {
			http.Error(w, "version", http.StatusConflict)
			return
		}
		for otherID, other := range f.pages {
			if otherID != id && strings.EqualFold(other.Title, input.Title) {
				http.Error(w, "duplicate title", http.StatusBadRequest)
				return
			}
		}
		old.Title = input.Title
		old.ParentID = input.ParentID
		old.Version.Number = input.Version.Number
		f.pages[id] = old
		f.bodies[id] = input.Body.Value
		json.NewEncoder(w).Encode(old)
	case r.Method == http.MethodPut && strings.Contains(path, "/properties/"):
		parts := strings.Split(path, "/")
		id := parts[5]
		old := f.properties[id]
		var input struct {
			Key     string
			Value   target.ManagedMetadata
			Version struct{ Number int }
		}
		mustDecode(f.t, r, &input)
		if input.Version.Number != old.Version.Number+1 {
			http.Error(w, "version", http.StatusConflict)
			return
		}
		old.Value = input.Value
		old.Version.Number = input.Version.Number
		f.properties[id] = old
		json.NewEncoder(w).Encode(old)
	case r.Method == http.MethodDelete && strings.HasPrefix(path, "/wiki/api/v2/pages/"):
		id := strings.Split(path, "/")[5]
		delete(f.pages, id)
		delete(f.properties, id)
		delete(f.bodies, id)
		w.WriteHeader(http.StatusNoContent)
	case r.Method == http.MethodDelete && strings.HasPrefix(path, "/wiki/api/v2/attachments/"):
		attachmentID := strings.Split(path, "/")[5]
		for pageID, attachments := range f.attachments {
			for name, attachment := range attachments {
				if attachment.ID == attachmentID {
					delete(f.attachments[pageID], name)
					w.WriteHeader(http.StatusNoContent)
					return
				}
			}
		}
		http.Error(w, "missing", http.StatusNotFound)
	default:
		f.t.Errorf("unexpected request %s %s", r.Method, r.URL.String())
		http.Error(w, "unexpected", http.StatusNotFound)
	}
}

func TestEngineAdoptsPendingSkeletonAfterLostCreateResponse(t *testing.T) {
	fake := newFake(t)
	fake.dropCreateOnce = true
	server := httptest.NewServer(fake)
	defer server.Close()
	client, clientErr := New(Options{BaseURL: server.URL, Email: "test@example.com", APIToken: "token", AllowInsecure: true})
	if clientErr != nil {
		t.Fatal(clientErr)
	}
	scope := target.Scope{Namespace: "recovery", SpaceID: "space", RootPageID: "root"}
	core := engine.Engine{Target: client}
	b := testBundle(t, []bundle.Document{{ID: "a", Title: "Recovered", Route: "/a", Source: bundle.Source{Path: "a.md"}, Blocks: []json.RawMessage{json.RawMessage(`{"type":"paragraph","inlines":[{"type":"text","value":"body"}]}`)}}})
	bundlePath := filepath.Join(t.TempDir(), "manifest.json")
	firstPlan, planErr := core.Plan(context.Background(), "docs", "wiki", "recovery", bundlePath, b, scope)
	if planErr != nil {
		t.Fatal(planErr)
	}
	if applyErr := core.Apply(context.Background(), firstPlan, b, scope, ""); applyErr == nil {
		t.Fatal("expected lost create response")
	}
	fake.mu.Lock()
	pagesAfterFailure := len(fake.pages)
	fake.mu.Unlock()
	if pagesAfterFailure != 1 {
		t.Fatalf("pages after ambiguous failure=%d", pagesAfterFailure)
	}
	secondPlan, planErr := core.Plan(context.Background(), "docs", "wiki", "recovery", bundlePath, b, scope)
	if planErr != nil {
		t.Fatal(planErr)
	}
	if applyErr := core.Apply(context.Background(), secondPlan, b, scope, ""); applyErr != nil {
		t.Fatal(applyErr)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.pages) != 1 {
		t.Fatalf("adoption created duplicates: %d pages", len(fake.pages))
	}
	for _, page := range fake.pages {
		if page.Title != "Recovered" {
			t.Fatalf("page title=%q", page.Title)
		}
	}
}

func mustDecode(t *testing.T, r *http.Request, out any) {
	t.Helper()
	if decodeErr := json.NewDecoder(r.Body).Decode(out); decodeErr != nil {
		t.Fatal(decodeErr)
	}
}

func TestEngineSynchronizesUpdatesAndDeletesWithFakeConfluence(t *testing.T) {
	fake := newFake(t)
	server := httptest.NewServer(fake)
	defer server.Close()
	client, err := New(Options{BaseURL: server.URL, Email: "test@example.com", APIToken: "token", AllowInsecure: true})
	if err != nil {
		t.Fatal(err)
	}
	scope := target.Scope{Namespace: "acceptance", SpaceID: "space", RootPageID: "root"}
	core := engine.Engine{Target: client}
	temp := t.TempDir()
	assetBytes := []byte("<svg/>")
	if writeErr := os.WriteFile(filepath.Join(temp, "diagram.svg"), assetBytes, 0o600); writeErr != nil {
		t.Fatal(writeErr)
	}
	assetSum := sha256.Sum256(assetBytes)
	assetID := "sha256:" + hex.EncodeToString(assetSum[:])
	first := &bundle.Bundle{SchemaVersion: 1, Site: bundle.Site{Name: "Test", BaseURL: "https://docs.example/"}, Documents: []bundle.Document{
		{ID: "a", Title: "Parent", Route: "/a", Source: bundle.Source{Path: "a.md", URL: "https://source/a.md", Commit: "abc"}, Blocks: []json.RawMessage{json.RawMessage(`{"type":"paragraph","inlines":[{"type":"link","target":{"kind":"document","value":"b"},"children":[{"type":"text","value":"Child"}]}]}`)}},
		{ID: "b", Title: "Child", Route: "/b", ParentID: "a", Order: 1, Source: bundle.Source{Path: "b.md"}, Blocks: []json.RawMessage{json.RawMessage(fmt.Sprintf(`{"type":"image","assetId":%q,"alt":"diagram"}`, assetID))}},
	}, Assets: []bundle.Asset{{ID: assetID, Path: "diagram.svg", MIMEType: "image/svg+xml", Hash: assetID}}}
	sealBundle(t, first)
	if validationErr := first.Validate(); validationErr != nil {
		t.Fatal(validationErr)
	}
	bundlePath := filepath.Join(temp, "manifest.json")
	p, err := core.Plan(context.Background(), "docs", "wiki", "acceptance", bundlePath, first, scope)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Operations) != 2 {
		t.Fatalf("operations=%v", p.Operations)
	}
	if applyErr := core.Apply(context.Background(), p, first, scope, ""); applyErr != nil {
		t.Fatal(applyErr)
	}
	fake.mu.Lock()
	parentID := ""
	childID := ""
	for pageID, managedProperty := range fake.properties {
		switch managedProperty.Value.DocumentID {
		case "a":
			parentID = pageID
		case "b":
			childID = pageID
		}
	}
	parentBody := fake.bodies[parentID]
	fake.mu.Unlock()
	if childID == "" || !strings.Contains(parentBody, `<ri:content-entity ri:content-id="`+childID+`" />`) {
		t.Fatalf("internal page link was not rendered by content ID: %s", parentBody)
	}
	noChanges, err := core.Plan(context.Background(), "docs", "wiki", "acceptance", bundlePath, first, scope)
	if err != nil {
		t.Fatal(err)
	}
	if len(noChanges.Operations) != 0 {
		t.Fatalf("not idempotent: %v", noChanges.Operations)
	}
	remoteBeforeEdit, err := client.Discover(context.Background(), scope)
	if err != nil {
		t.Fatal(err)
	}
	var childBeforeEdit target.RemoteDocument
	for _, remoteDocument := range remoteBeforeEdit {
		if remoteDocument.Metadata.DocumentID == "b" {
			childBeforeEdit = remoteDocument
		}
	}
	fake.mu.Lock()
	attachmentFilename := ""
	for filename := range fake.attachments[childBeforeEdit.ID] {
		attachmentFilename = filename
	}
	fake.mu.Unlock()
	asset := target.Asset{ID: assetID, Path: filepath.Join(temp, "diagram.svg"), Filename: attachmentFilename, Hash: assetID, MIMEType: "image/svg+xml"}
	if uploadErr := client.UploadAsset(context.Background(), childBeforeEdit, asset); uploadErr != nil {
		t.Fatal(uploadErr)
	}
	fake.mu.Lock()
	uploadsAfterHashMatch := fake.uploads
	fake.mu.Unlock()
	if uploadsAfterHashMatch != 1 {
		t.Fatalf("unchanged attachment was uploaded again: %d uploads", uploadsAfterHashMatch)
	}
	fake.mu.Lock()
	fake.attachments[childBeforeEdit.ID]["docusynx-stale.svg"] = struct{ ID, Hash string }{"stale", "old"}
	fake.attachments[childBeforeEdit.ID]["user-file.pdf"] = struct{ ID, Hash string }{"user", ""}
	fake.mu.Unlock()
	if reconcileErr := client.ReconcileAssets(context.Background(), childBeforeEdit, []target.Asset{asset}); reconcileErr != nil {
		t.Fatal(reconcileErr)
	}
	fake.mu.Lock()
	_, staleExists := fake.attachments[childBeforeEdit.ID]["docusynx-stale.svg"]
	_, userExists := fake.attachments[childBeforeEdit.ID]["user-file.pdf"]
	fake.mu.Unlock()
	if staleExists || !userExists {
		t.Fatalf("attachment reconciliation stale=%v user=%v", staleExists, userExists)
	}
	fake.mu.Lock()
	editedPage := fake.pages[childBeforeEdit.ID]
	editedPage.Version.Number++
	fake.pages[childBeforeEdit.ID] = editedPage
	fake.mu.Unlock()
	if deleteErr := client.Delete(context.Background(), scope, childBeforeEdit); deleteErr == nil {
		t.Fatal("delete accepted a page edit after its snapshot")
	}
	fake.mu.Lock()
	if len(fake.pages) != 2 {
		t.Fatalf("pages=%d", len(fake.pages))
	}
	if fake.uploads != 1 {
		t.Errorf("asset uploads=%d", fake.uploads)
	}
	for id := range fake.pages {
		if !fake.labels[id]["autogenerated"] || !fake.labels[id]["docusynx-managed"] {
			t.Errorf("labels missing for %s", id)
		}
		if !strings.Contains(fake.bodies[id], "generated from documentation") {
			t.Errorf("banner missing for %s", id)
		}
	}
	fake.mu.Unlock()
	second := testBundle(t, []bundle.Document{{ID: "a", Title: "Renamed Parent", Route: "/a", Source: bundle.Source{Path: "a.md", URL: "https://source/a.md"}, Blocks: []json.RawMessage{json.RawMessage(`{"type":"paragraph","inlines":[{"type":"text","value":"Changed"}]}`)}}})
	p, err = core.Plan(context.Background(), "docs", "wiki", "acceptance", bundlePath, second, scope)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Operations) != 2 || p.Operations[0].Type != "update" || p.Operations[1].Type != "delete" {
		t.Fatalf("operations=%v", p.Operations)
	}
	if applyErr := core.Apply(context.Background(), p, second, scope, ""); applyErr != nil {
		t.Fatal(applyErr)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.pages) != 1 {
		t.Fatalf("pages after delete=%d", len(fake.pages))
	}
}

func TestLabelFailureRemainsVisibleForRetry(t *testing.T) {
	fake := newFake(t)
	server := httptest.NewServer(fake)
	defer server.Close()
	client, clientErr := New(Options{BaseURL: server.URL, Email: "test@example.com", APIToken: "token", AllowInsecure: true})
	if clientErr != nil {
		t.Fatal(clientErr)
	}
	scope := target.Scope{Namespace: "labels", SpaceID: "space", RootPageID: "root"}
	core := engine.Engine{Target: client}
	bundlePath := filepath.Join(t.TempDir(), "manifest.json")
	initial := testBundle(t, []bundle.Document{{ID: "a", Title: "A", Route: "/a", Source: bundle.Source{Path: "a.md"}, Blocks: []json.RawMessage{json.RawMessage(`{"type":"paragraph","inlines":[{"type":"text","value":"first"}]}`)}}})
	initialPlan, planErr := core.Plan(context.Background(), "docs", "wiki", "labels", bundlePath, initial, scope)
	if planErr != nil {
		t.Fatal(planErr)
	}
	if applyErr := core.Apply(context.Background(), initialPlan, initial, scope, ""); applyErr != nil {
		t.Fatal(applyErr)
	}
	changed := testBundle(t, []bundle.Document{{ID: "a", Title: "A", Route: "/a", Source: bundle.Source{Path: "a.md"}, Blocks: []json.RawMessage{json.RawMessage(`{"type":"paragraph","inlines":[{"type":"text","value":"changed"}]}`)}}})
	changedPlan, planErr := core.Plan(context.Background(), "docs", "wiki", "labels", bundlePath, changed, scope)
	if planErr != nil {
		t.Fatal(planErr)
	}
	fake.mu.Lock()
	fake.failLabelRequests = 3
	fake.mu.Unlock()
	if applyErr := core.Apply(context.Background(), changedPlan, changed, scope, ""); applyErr == nil {
		t.Fatal("expected label failure")
	}
	retryPlan, planErr := core.Plan(context.Background(), "docs", "wiki", "labels", bundlePath, changed, scope)
	if planErr != nil {
		t.Fatal(planErr)
	}
	if len(retryPlan.Operations) != 1 || retryPlan.Operations[0].Type != "update" {
		t.Fatalf("label failure became invisible: %+v", retryPlan.Operations)
	}
}

func TestEngineDisambiguatesCaseInsensitiveConfluenceTitles(t *testing.T) {
	fake := newFake(t)
	server := httptest.NewServer(fake)
	defer server.Close()
	client, clientErr := New(Options{BaseURL: server.URL, Email: "test@example.com", APIToken: "token", AllowInsecure: true})
	if clientErr != nil {
		t.Fatal(clientErr)
	}
	scope := target.Scope{Namespace: "titles", SpaceID: "space", RootPageID: "root"}
	core := engine.Engine{Target: client}
	b := testBundle(t, []bundle.Document{
		{ID: "a", Title: "Globals", Route: "/a", Source: bundle.Source{Path: "a.md"}, Blocks: []json.RawMessage{json.RawMessage(`{"type":"paragraph","inlines":[{"type":"text","value":"first"}]}`)}},
		{ID: "b", Title: "globals", Route: "/b", Source: bundle.Source{Path: "b.md"}, Blocks: []json.RawMessage{json.RawMessage(`{"type":"paragraph","inlines":[{"type":"text","value":"second"}]}`)}},
	})
	bundlePath := filepath.Join(t.TempDir(), "manifest.json")
	p, planErr := core.Plan(context.Background(), "docs", "wiki", "titles", bundlePath, b, scope)
	if planErr != nil {
		t.Fatal(planErr)
	}
	if applyErr := core.Apply(context.Background(), p, b, scope, ""); applyErr != nil {
		t.Fatal(applyErr)
	}
	fake.mu.Lock()
	titles := make([]string, 0, len(fake.pages))
	for _, remotePage := range fake.pages {
		titles = append(titles, remotePage.Title)
	}
	fake.mu.Unlock()
	sort.Strings(titles)
	if len(titles) != 2 || titles[0] != "Globals" || !strings.HasPrefix(titles[1], "globals · docusynx-") {
		t.Fatalf("titles=%v", titles)
	}
	noChanges, planErr := core.Plan(context.Background(), "docs", "wiki", "titles", bundlePath, b, scope)
	if planErr != nil {
		t.Fatal(planErr)
	}
	if len(noChanges.Operations) != 0 {
		t.Fatalf("title disambiguation is not idempotent: %v", noChanges.Operations)
	}
}

func testBundle(t *testing.T, documents []bundle.Document) *bundle.Bundle {
	t.Helper()
	b := &bundle.Bundle{SchemaVersion: 1, Site: bundle.Site{Name: "Test", BaseURL: "https://docs.example/"}, Documents: documents, Assets: []bundle.Asset{}}
	sealBundle(t, b)
	if validationErr := b.Validate(); validationErr != nil {
		t.Fatal(validationErr)
	}
	return b
}

func sealBundle(t *testing.T, b *bundle.Bundle) {
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
