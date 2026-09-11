package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/dieend/docusynx/internal/plan"
	"github.com/dieend/docusynx/pkg/bundle"
	"github.com/dieend/docusynx/pkg/target"
)

type Engine struct {
	Target target.Target
}

func (e Engine) Plan(ctx context.Context, publication, targetName, namespace, bundlePath string, b *bundle.Bundle, scope target.Scope) (*plan.Plan, error) {
	if validationErr := b.Validate(); validationErr != nil {
		return nil, fmt.Errorf("validate bundle: %w", validationErr)
	}
	if validationErr := b.ValidateFiles(bundlePath); validationErr != nil {
		return nil, fmt.Errorf("validate bundle assets: %w", validationErr)
	}
	remote, err := e.Target.Discover(ctx, scope)
	if err != nil {
		return nil, fmt.Errorf("discover remote documents: %w", err)
	}
	return plan.Build(publication, targetName, namespace, bundlePath, b, remote)
}

func (e Engine) Apply(ctx context.Context, p *plan.Plan, b *bundle.Bundle, scope target.Scope, sourceURLTemplate string) error {
	if validationErr := b.Validate(); validationErr != nil {
		return fmt.Errorf("validate bundle: %w", validationErr)
	}
	if p.SchemaVersion != plan.SchemaVersion {
		return fmt.Errorf("unsupported plan schemaVersion %d", p.SchemaVersion)
	}
	if p.BundleHash != b.Hash {
		return fmt.Errorf("plan bundle hash %q does not match bundle hash %q", p.BundleHash, b.Hash)
	}
	if validationErr := b.ValidateFiles(p.BundlePath); validationErr != nil {
		return fmt.Errorf("validate bundle assets: %w", validationErr)
	}
	if validationErr := validateSourceURLs(b, sourceURLTemplate); validationErr != nil {
		return validationErr
	}
	remote, err := e.Target.Discover(ctx, scope)
	if err != nil {
		return fmt.Errorf("verify remote documents: %w", err)
	}
	if got := plan.SnapshotHash(remote); got != p.RemoteSnapshotHash {
		return fmt.Errorf("remote state changed after plan: got snapshot %s, want %s", got, p.RemoteSnapshotHash)
	}
	remoteByDoc := make(map[string]target.RemoteDocument, len(remote))
	ids := make(map[string]string, len(remote))
	for _, r := range remote {
		remoteByDoc[r.Metadata.DocumentID] = r
		ids[r.Metadata.DocumentID] = r.ID
	}
	documents := b.DocumentMap()
	assetByID := make(map[string]bundle.Asset, len(b.Assets))
	assetFilenames := make(map[string]string, len(b.Assets))
	for _, asset := range b.Assets {
		id := asset.Identifier()
		assetByID[id] = asset
		assetFilenames[id] = assetFilename(asset)
	}
	create := map[string]bool{}
	update := map[string]bool{}
	var deletes []plan.Operation
	for _, op := range p.Operations {
		switch op.Type {
		case "create":
			create[op.DocumentID] = true
		case "update":
			update[op.DocumentID] = true
		case "delete":
			deletes = append(deletes, op)
		default:
			return fmt.Errorf("unsupported operation %q", op.Type)
		}
	}

	// Create parent skeletons before children. This also obtains every page ID
	// before content links are rendered.
	for len(create) > 0 {
		progress := false
		names := sortedKeys(create)
		for _, id := range names {
			d, ok := documents[id]
			if !ok {
				return fmt.Errorf("create refers to missing document %q", id)
			}
			parentRemoteID := scope.RootPageID
			if d.ParentID != "" {
				var found bool
				parentRemoteID, found = ids[d.ParentID]
				if !found {
					continue
				}
			}
			mutation := mutation(scope, d, parentRemoteID, ids, sourceURLTemplate, assetFilenames)
			r, err := e.Target.CreateSkeleton(ctx, mutation)
			if err != nil {
				return fmt.Errorf("create skeleton for %q: %w", id, err)
			}
			remoteByDoc[id] = r
			ids[id] = r.ID
			delete(create, id)
			update[id] = true
			progress = true
		}
		if !progress {
			return fmt.Errorf("cannot resolve parents for creates: %v", sortedKeys(create))
		}
	}

	for _, id := range sortedKeys(update) {
		d, ok := documents[id]
		if !ok {
			return fmt.Errorf("update refers to missing document %q", id)
		}
		r, ok := remoteByDoc[id]
		if !ok {
			return fmt.Errorf("update refers to missing remote document %q", id)
		}
		parentRemoteID := scope.RootPageID
		if d.ParentID != "" {
			parentRemoteID = ids[d.ParentID]
		}
		var desiredAssets []target.Asset
		for _, assetID := range documentAssets(d) {
			asset, ok := assetByID[assetID]
			if !ok {
				return fmt.Errorf("document %q refers to missing asset %q", id, assetID)
			}
			input := target.Asset{ID: assetID, Path: filepath.Join(filepath.Dir(p.BundlePath), asset.Path), Filename: assetFilenames[assetID], Hash: asset.Hash, MIMEType: asset.MIMEType}
			desiredAssets = append(desiredAssets, input)
			if uploadErr := e.Target.UploadAsset(ctx, r, input); uploadErr != nil {
				return fmt.Errorf("upload asset %q for %q: %w", assetID, id, uploadErr)
			}
		}
		if reconcileErr := e.Target.ReconcileAssets(ctx, r, desiredAssets); reconcileErr != nil {
			return fmt.Errorf("reconcile assets for %q: %w", id, reconcileErr)
		}
		mutation := mutation(scope, d, parentRemoteID, ids, sourceURLTemplate, assetFilenames)
		if _, updateErr := e.Target.Update(ctx, r, mutation); updateErr != nil {
			return fmt.Errorf("update %q: %w", id, updateErr)
		}
	}

	// Delete children before parents. The target repeats the ownership check.
	sort.Slice(deletes, func(i, j int) bool {
		left := hierarchyDepth(deletes[i].DocumentID, remoteByDoc)
		right := hierarchyDepth(deletes[j].DocumentID, remoteByDoc)
		if left != right {
			return left > right
		}
		return deletes[i].DocumentID < deletes[j].DocumentID
	})
	for _, op := range deletes {
		r, ok := remoteByDoc[op.DocumentID]
		if !ok || r.ID != op.RemoteID || r.Version != op.ExpectedVersion {
			return fmt.Errorf("delete precondition failed for %q", op.DocumentID)
		}
		if deleteErr := e.Target.Delete(ctx, scope, r); deleteErr != nil {
			return fmt.Errorf("delete %q: %w", op.DocumentID, deleteErr)
		}
	}
	return nil
}

func validateSourceURLs(b *bundle.Bundle, template string) error {
	for _, document := range b.Documents {
		value := document.Source.URL
		if value == "" && template != "" {
			value = strings.ReplaceAll(template, "{commit}", document.Source.Commit)
			value = strings.ReplaceAll(value, "{path}", document.Source.Path)
		}
		if value == "" {
			continue
		}
		parsed, parseErr := url.Parse(value)
		if parseErr != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			return fmt.Errorf("document %q source URL must be absolute http or https", document.ID)
		}
	}
	return nil
}

func mutation(scope target.Scope, d bundle.Document, parentRemoteID string, ids map[string]string, template string, assetFilenames map[string]string) target.Mutation {
	url := d.Source.URL
	if url == "" && template != "" {
		url = strings.ReplaceAll(template, "{commit}", d.Source.Commit)
		url = strings.ReplaceAll(url, "{path}", d.Source.Path)
	}
	return target.Mutation{Scope: scope, Document: d, ParentRemoteID: parentRemoteID, DocumentIDs: ids, SourceURL: url, AssetFilenames: assetFilenames}
}

func documentAssets(d bundle.Document) []string {
	found := map[string]bool{}
	var visit func(any)
	visit = func(value any) {
		switch current := value.(type) {
		case map[string]any:
			if current["type"] == "image" {
				if id, ok := current["assetId"].(string); ok {
					found[id] = true
				}
			}
			for _, child := range current {
				visit(child)
			}
		case []any:
			for _, child := range current {
				visit(child)
			}
		}
	}
	for _, raw := range d.Blocks {
		var value any
		if json.Unmarshal(raw, &value) == nil {
			visit(value)
		}
	}
	return sortedKeys(found)
}

var filenameUnsafe = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

func assetFilename(asset bundle.Asset) string {
	id := strings.Trim(filenameUnsafe.ReplaceAllString(asset.Identifier(), "-"), "-.")
	if id == "" {
		id = "asset"
	}
	ext := filepath.Ext(asset.Path)
	if ext != "" && !strings.HasSuffix(id, ext) {
		id += ext
	}
	return "docusynx-" + id
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func hierarchyDepth(id string, remote map[string]target.RemoteDocument) int {
	depth := 0
	seen := map[string]bool{}
	for id != "" && !seen[id] {
		seen[id] = true
		depth++
		id = remote[id].Metadata.ParentDocument
	}
	return depth
}
