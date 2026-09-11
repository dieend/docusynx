// Package target defines the public wiki target contract.
package target

import (
	"context"

	"github.com/dieend/docusynx/pkg/bundle"
)

type Scope struct {
	Namespace  string
	SpaceID    string
	RootPageID string
}

type ManagedMetadata struct {
	Namespace       string `json:"namespace"`
	DocumentID      string `json:"documentId"`
	DocumentHash    string `json:"documentHash"`
	ParentDocument  string `json:"parentDocumentId,omitempty"`
	SourcePath      string `json:"sourcePath,omitempty"`
	SourceURL       string `json:"sourceUrl,omitempty"`
	SourceCommit    string `json:"sourceCommit,omitempty"`
	RendererVersion int    `json:"rendererVersion,omitempty"`
	PageVersion     int    `json:"pageVersion"`
}

type RemoteDocument struct {
	ID              string
	Title           string
	ParentID        string
	Version         int
	PropertyID      string
	PropertyVersion int
	Metadata        ManagedMetadata
}

type Asset struct {
	ID       string
	Path     string
	Filename string
	Hash     string
	MIMEType string
}

type Mutation struct {
	Scope          Scope
	Document       bundle.Document
	ParentRemoteID string
	DocumentIDs    map[string]string
	SourceURL      string
	AssetFilenames map[string]string
}

// Target implementations must make CreateSkeleton and Update idempotent for
// the same managed document identity. Delete must refuse unmanaged objects.
type Target interface {
	Discover(context.Context, Scope) ([]RemoteDocument, error)
	CreateSkeleton(context.Context, Mutation) (RemoteDocument, error)
	UploadAsset(context.Context, RemoteDocument, Asset) error
	ReconcileAssets(context.Context, RemoteDocument, []Asset) error
	Update(context.Context, RemoteDocument, Mutation) (RemoteDocument, error)
	Delete(context.Context, Scope, RemoteDocument) error
}
