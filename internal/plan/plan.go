package plan

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/dieend/docusynx/pkg/bundle"
	"github.com/dieend/docusynx/pkg/target"
)

const SchemaVersion = 1

type Plan struct {
	SchemaVersion      int         `json:"schemaVersion"`
	Publication        string      `json:"publication"`
	Target             string      `json:"target"`
	Namespace          string      `json:"namespace"`
	BundlePath         string      `json:"bundlePath"`
	BundleHash         string      `json:"bundleHash"`
	RemoteSnapshotHash string      `json:"remoteSnapshotHash"`
	Operations         []Operation `json:"operations"`
}

type File struct {
	SchemaVersion int     `json:"schemaVersion"`
	Plans         []*Plan `json:"plans"`
}

type Operation struct {
	Type            string `json:"type"`
	DocumentID      string `json:"documentId"`
	RemoteID        string `json:"remoteId,omitempty"`
	ExpectedVersion int    `json:"expectedVersion,omitempty"`
	Reason          string `json:"reason,omitempty"`
}

func Build(publication, targetName, namespace, bundlePath string, b *bundle.Bundle, remote []target.RemoteDocument) (*Plan, error) {
	remoteByDoc := make(map[string]target.RemoteDocument, len(remote))
	for _, r := range remote {
		if r.Metadata.DocumentID == "" {
			return nil, fmt.Errorf("remote page %q has no managed document id", r.ID)
		}
		if _, ok := remoteByDoc[r.Metadata.DocumentID]; ok {
			return nil, fmt.Errorf("multiple managed pages use document id %q", r.Metadata.DocumentID)
		}
		remoteByDoc[r.Metadata.DocumentID] = r
	}
	desired := b.DocumentMap()
	var operations []Operation
	for _, d := range b.Documents {
		r, ok := remoteByDoc[d.ID]
		if !ok {
			operations = append(operations, Operation{Type: "create", DocumentID: d.ID, Reason: "not found"})
			continue
		}
		delete(remoteByDoc, d.ID)
		var reason string
		switch {
		case r.Title != d.Title:
			reason = "title changed"
		case r.Metadata.ParentDocument != d.ParentID:
			reason = "parent changed"
		case r.Metadata.DocumentHash != d.Hash:
			reason = "content changed"
		case r.Metadata.PageVersion != r.Version:
			reason = "remote page changed"
		}
		if reason != "" {
			operations = append(operations, Operation{Type: "update", DocumentID: d.ID, RemoteID: r.ID, ExpectedVersion: r.Version, Reason: reason})
		}
	}
	for id, r := range remoteByDoc {
		if _, ok := desired[id]; ok {
			continue
		}
		operations = append(operations, Operation{Type: "delete", DocumentID: id, RemoteID: r.ID, ExpectedVersion: r.Version, Reason: "document removed"})
	}
	sort.Slice(operations, func(i, j int) bool {
		if operations[i].Type != operations[j].Type {
			return operationRank(operations[i].Type) < operationRank(operations[j].Type)
		}
		return operations[i].DocumentID < operations[j].DocumentID
	})
	return &Plan{
		SchemaVersion:      SchemaVersion,
		Publication:        publication,
		Target:             targetName,
		Namespace:          namespace,
		BundlePath:         bundlePath,
		BundleHash:         b.Hash,
		RemoteSnapshotHash: SnapshotHash(remote),
		Operations:         operations,
	}, nil
}

func operationRank(op string) int {
	switch op {
	case "create":
		return 0
	case "update":
		return 1
	default:
		return 2
	}
}

func SnapshotHash(remote []target.RemoteDocument) string {
	type snapshot struct {
		ID              string                 `json:"id"`
		Title           string                 `json:"title"`
		ParentID        string                 `json:"parentId"`
		Version         int                    `json:"version"`
		PropertyID      string                 `json:"propertyId"`
		PropertyVersion int                    `json:"propertyVersion"`
		Metadata        target.ManagedMetadata `json:"metadata"`
	}
	values := make([]snapshot, 0, len(remote))
	for _, r := range remote {
		values = append(values, snapshot{r.ID, r.Title, r.ParentID, r.Version, r.PropertyID, r.PropertyVersion, r.Metadata})
	}
	sort.Slice(values, func(i, j int) bool { return values[i].ID < values[j].ID })
	data, _ := json.Marshal(values)
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}
