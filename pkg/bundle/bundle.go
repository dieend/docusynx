// Package bundle defines the stable interchange format produced by a source
// exporter and consumed by the synchronization engine.
package bundle

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const SchemaVersion = 1

type Bundle struct {
	SchemaVersion int        `json:"schemaVersion"`
	Site          Site       `json:"site"`
	Documents     []Document `json:"documents"`
	Assets        []Asset    `json:"assets"`
	Hash          string     `json:"hash"`
}

type Document struct {
	ID       string            `json:"id"`
	Title    string            `json:"title"`
	Route    string            `json:"route"`
	ParentID string            `json:"parentId,omitempty"`
	Order    int               `json:"order"`
	Source   Source            `json:"source"`
	Blocks   []json.RawMessage `json:"blocks"`
	Hash     string            `json:"hash"`
}

type Source struct {
	Path   string `json:"path"`
	URL    string `json:"url,omitempty"`
	Commit string `json:"commit,omitempty"`
}

type Site struct {
	Name          string `json:"name"`
	BaseURL       string `json:"baseUrl"`
	SourceBaseURL string `json:"sourceBaseUrl,omitempty"`
	SourceCommit  string `json:"sourceCommit,omitempty"`
}

type Asset struct {
	ID       string `json:"id,omitempty"`
	Path     string `json:"path"`
	MIMEType string `json:"mimeType"`
	Hash     string `json:"hash"`
}

func Load(path string) (*Bundle, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read bundle: %w", err)
	}
	return Parse(b)
}

func Parse(data []byte) (*Bundle, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var b Bundle
	if decodeErr := dec.Decode(&b); decodeErr != nil {
		return nil, fmt.Errorf("decode bundle: %w", decodeErr)
	}
	var extra any
	if trailingErr := dec.Decode(&extra); !errors.Is(trailingErr, io.EOF) {
		if trailingErr == nil {
			return nil, errors.New("decode bundle: extra JSON content")
		}
		return nil, fmt.Errorf("decode bundle: %w", trailingErr)
	}
	if validationErr := b.Validate(); validationErr != nil {
		return nil, validationErr
	}
	return &b, nil
}

func (b *Bundle) Validate() error {
	if b.SchemaVersion != SchemaVersion {
		return fmt.Errorf("unsupported bundle schemaVersion %d", b.SchemaVersion)
	}
	if b.Site.Name == "" || b.Site.BaseURL == "" {
		return errors.New("bundle site.name and site.baseUrl are required")
	}
	if urlErr := validateHTTPURL(b.Site.BaseURL); urlErr != nil {
		return fmt.Errorf("bundle site.baseUrl: %w", urlErr)
	}
	if b.Site.SourceBaseURL != "" {
		if urlErr := validateHTTPURL(b.Site.SourceBaseURL); urlErr != nil {
			return fmt.Errorf("bundle site.sourceBaseUrl: %w", urlErr)
		}
	}
	seen := make(map[string]bool, len(b.Documents))
	for i := range b.Documents {
		d := &b.Documents[i]
		if d.ID == "" || d.Title == "" || d.Route == "" {
			return fmt.Errorf("documents[%d]: id, title, and route are required", i)
		}
		if seen[d.ID] {
			return fmt.Errorf("documents[%d]: duplicate id %q", i, d.ID)
		}
		if d.Source.URL != "" {
			if urlErr := validateHTTPURL(d.Source.URL); urlErr != nil {
				return fmt.Errorf("document %q source.url: %w", d.ID, urlErr)
			}
		}
		seen[d.ID] = true
		if len(d.Blocks) == 0 {
			return fmt.Errorf("document %q: blocks are required", d.ID)
		}
		calculated, err := d.CalculateHash()
		if err != nil {
			return fmt.Errorf("document %q hash: %w", d.ID, err)
		}
		if d.Hash == "" {
			return fmt.Errorf("document %q hash is required", d.ID)
		}
		if !equalHash(d.Hash, calculated) {
			return fmt.Errorf("document %q hash mismatch: got %q, want %q", d.ID, d.Hash, calculated)
		}
	}
	for _, d := range b.Documents {
		if d.ParentID != "" && !seen[d.ParentID] {
			return fmt.Errorf("document %q refers to missing parent %q", d.ID, d.ParentID)
		}
	}
	if hierarchyErr := validateHierarchy(b.Documents); hierarchyErr != nil {
		return hierarchyErr
	}
	if !sort.SliceIsSorted(b.Documents, func(i, j int) bool { return b.Documents[i].ID < b.Documents[j].ID }) {
		return errors.New("documents must be ordered by id")
	}
	assetSeen := map[string]bool{}
	for i := range b.Assets {
		id := b.Assets[i].Identifier()
		if id == "" || b.Assets[i].Path == "" || b.Assets[i].MIMEType == "" || b.Assets[i].Hash == "" {
			return fmt.Errorf("assets[%d]: id, path, mimeType, and hash are required", i)
		}
		if !validSHA256(id) || !validSHA256(b.Assets[i].Hash) || id != b.Assets[i].Hash {
			return fmt.Errorf("assets[%d]: id and hash must be the same sha256 content hash", i)
		}
		if _, _, mimeErr := mime.ParseMediaType(b.Assets[i].MIMEType); mimeErr != nil {
			return fmt.Errorf("assets[%d]: invalid mimeType: %w", i, mimeErr)
		}
		cleanPath := filepath.Clean(b.Assets[i].Path)
		if filepath.IsAbs(b.Assets[i].Path) || cleanPath == ".." || strings.HasPrefix(cleanPath, ".."+string(filepath.Separator)) {
			return fmt.Errorf("assets[%d]: path must stay within the bundle directory", i)
		}
		if assetSeen[id] {
			return fmt.Errorf("assets[%d]: duplicate id %q", i, id)
		}
		assetSeen[id] = true
	}
	if !sort.SliceIsSorted(b.Assets, func(i, j int) bool { return b.Assets[i].ID < b.Assets[j].ID }) {
		return errors.New("assets must be ordered by id")
	}
	for _, d := range b.Documents {
		for i, raw := range d.Blocks {
			if blockErr := validateBlock(raw, seen, assetSeen); blockErr != nil {
				return fmt.Errorf("document %q block %d: %w", d.ID, i, blockErr)
			}
		}
	}
	calculated, err := b.CalculateHash()
	if err != nil {
		return fmt.Errorf("bundle hash: %w", err)
	}
	if b.Hash == "" {
		return errors.New("bundle hash is required")
	}
	if !equalHash(b.Hash, calculated) {
		return fmt.Errorf("bundle hash mismatch: got %q, want %q", b.Hash, calculated)
	}
	return nil
}

// ValidateFiles verifies that every asset is a regular file inside the bundle
// directory and that its bytes match the declared content hash.
func (b *Bundle) ValidateFiles(bundlePath string) error {
	root, err := filepath.Abs(filepath.Dir(bundlePath))
	if err != nil {
		return err
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return fmt.Errorf("resolve bundle directory: %w", err)
	}
	for _, asset := range b.Assets {
		resolved, resolveErr := filepath.EvalSymlinks(filepath.Join(root, asset.Path))
		if resolveErr != nil {
			return fmt.Errorf("asset %q: resolve file: %w", asset.ID, resolveErr)
		}
		relative, relativeErr := filepath.Rel(root, resolved)
		if relativeErr != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return fmt.Errorf("asset %q: resolved path leaves the bundle directory", asset.ID)
		}
		file, openErr := os.Open(resolved)
		if openErr != nil {
			return fmt.Errorf("asset %q: open file: %w", asset.ID, openErr)
		}
		info, statErr := file.Stat()
		if statErr != nil {
			file.Close()
			return fmt.Errorf("asset %q: stat file: %w", asset.ID, statErr)
		}
		if !info.Mode().IsRegular() {
			file.Close()
			return fmt.Errorf("asset %q: path is not a regular file", asset.ID)
		}
		hasher := sha256.New()
		if _, copyErr := io.Copy(hasher, file); copyErr != nil {
			file.Close()
			return fmt.Errorf("asset %q: hash file: %w", asset.ID, copyErr)
		}
		if closeErr := file.Close(); closeErr != nil {
			return fmt.Errorf("asset %q: close file: %w", asset.ID, closeErr)
		}
		actual := "sha256:" + hex.EncodeToString(hasher.Sum(nil))
		if actual != asset.Hash {
			return fmt.Errorf("asset %q: content hash mismatch: got %s, want %s", asset.ID, actual, asset.Hash)
		}
	}
	return nil
}

func validSHA256(value string) bool {
	encoded := strings.TrimPrefix(value, "sha256:")
	if !strings.HasPrefix(value, "sha256:") || len(encoded) != sha256.Size*2 {
		return false
	}
	_, err := hex.DecodeString(encoded)
	return err == nil
}

func validateHTTPURL(value string) error {
	parsed, err := url.Parse(value)
	if err != nil {
		return err
	}
	if (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return errors.New("must be an absolute http or https URL")
	}
	return nil
}

func validateHierarchy(documents []Document) error {
	parents := make(map[string]string, len(documents))
	for _, d := range documents {
		parents[d.ID] = d.ParentID
	}
	for _, d := range documents {
		seen := map[string]bool{}
		for id := d.ID; id != ""; id = parents[id] {
			if seen[id] {
				return fmt.Errorf("document hierarchy contains a cycle at %q", id)
			}
			seen[id] = true
		}
	}
	return nil
}

func (a Asset) Identifier() string {
	return a.ID
}

func (d Document) CalculateHash() (string, error) {
	v := struct {
		ID       string            `json:"id"`
		Title    string            `json:"title"`
		Route    string            `json:"route"`
		ParentID string            `json:"parentId,omitempty"`
		Order    int               `json:"order"`
		Source   Source            `json:"source"`
		Blocks   []json.RawMessage `json:"blocks"`
	}{d.ID, d.Title, d.Route, d.ParentID, d.Order, d.Source, d.Blocks}
	return hashJSON(v)
}

func (b Bundle) CalculateHash() (string, error) {
	v := struct {
		SchemaVersion int        `json:"schemaVersion"`
		Site          Site       `json:"site"`
		Documents     []Document `json:"documents"`
		Assets        []Asset    `json:"assets"`
	}{b.SchemaVersion, b.Site, b.Documents, b.Assets}
	// Document hashes are part of the bundle contract.
	return hashJSON(v)
}

func hashJSON(v any) (string, error) {
	data, err := encodeCanonicalInput(v)
	if err != nil {
		return "", err
	}
	var canonical any
	if decodeErr := json.Unmarshal(data, &canonical); decodeErr != nil {
		return "", decodeErr
	}
	data, err = encodeCanonicalInput(canonical)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

func encodeCanonicalInput(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if encodeErr := encoder.Encode(value); encodeErr != nil {
		return nil, encodeErr
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'}), nil
}

func equalHash(a, b string) bool {
	return strings.TrimPrefix(a, "sha256:") == strings.TrimPrefix(b, "sha256:")
}

func (b *Bundle) DocumentMap() map[string]Document {
	out := make(map[string]Document, len(b.Documents))
	for _, d := range b.Documents {
		out[d.ID] = d
	}
	return out
}
