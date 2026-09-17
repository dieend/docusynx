// Package confluence implements a Confluence Cloud target. Page and content
// property operations use REST API v2. Confluence Cloud REST API v2 has no
// write endpoint for labels or attachments, so only those writes use REST API
// v1. All reads, including attachment discovery, use REST API v2.
package confluence

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dieend/docusynx/pkg/target"
)

const (
	propertyKey     = "docusynx.managed"
	rendererVersion = 2
)

type Options struct {
	BaseURL       string
	Email         string
	APIToken      string
	HTTPClient    *http.Client
	AllowInsecure bool
}

type Client struct {
	base       *url.URL
	email      string
	token      string
	httpClient *http.Client
	mu         sync.Mutex
	allPages   map[string]page
	managed    map[string]bool
}

type page struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	ParentID string `json:"parentId"`
	Version  struct {
		Number int `json:"number"`
	} `json:"version"`
}

type pageWithBody struct {
	page
	Body struct {
		Storage struct {
			Value string `json:"value"`
		} `json:"storage"`
	} `json:"body"`
}

type property struct {
	ID      string                 `json:"id"`
	Key     string                 `json:"key"`
	Value   target.ManagedMetadata `json:"value"`
	Version struct {
		Number int `json:"number"`
	} `json:"version"`
}

func New(options Options) (*Client, error) {
	parsed, err := url.Parse(strings.TrimSuffix(options.BaseURL, "/"))
	if err != nil || parsed.Host == "" {
		return nil, fmt.Errorf("invalid Confluence base URL %q", options.BaseURL)
	}
	if parsed.Scheme != "https" && !options.AllowInsecure {
		return nil, errors.New("Confluence base URL must use https")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("unsupported Confluence URL scheme %q", parsed.Scheme)
	}
	if parsed.User != nil {
		return nil, errors.New("Confluence base URL must not contain credentials")
	}
	parsed.Path = strings.TrimSuffix(strings.TrimSuffix(parsed.Path, "/"), "/wiki")
	parsed.RawQuery = ""
	parsed.Fragment = ""
	if options.Email == "" || options.APIToken == "" {
		return nil, errors.New("Confluence email and API token are required")
	}
	client := options.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	clone := *client
	previousRedirect := clone.CheckRedirect
	clone.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if req.URL.Scheme != parsed.Scheme || req.URL.Host != parsed.Host {
			return errors.New("refusing a cross-origin Confluence redirect")
		}
		if previousRedirect != nil {
			return previousRedirect(req, via)
		}
		if len(via) >= 10 {
			return errors.New("too many Confluence redirects")
		}
		return nil
	}
	return &Client{base: parsed, email: options.Email, token: options.APIToken, httpClient: &clone}, nil
}

func (c *Client) Discover(ctx context.Context, scope target.Scope) ([]target.RemoteDocument, error) {
	query := url.Values{}
	query.Set("limit", "250")
	query.Set("space-id", scope.SpaceID)
	next := c.apiV2("/pages?" + query.Encode())
	all := map[string]page{}
	for next != "" {
		var response struct {
			Results []page `json:"results"`
			Links   struct {
				Next string `json:"next"`
			} `json:"_links"`
		}
		if requestErr := c.get(ctx, next, &response); requestErr != nil {
			return nil, requestErr
		}
		for _, p := range response.Results {
			all[p.ID] = p
		}
		var err error
		next, err = c.nextURL(response.Links.Next)
		if err != nil {
			return nil, err
		}
	}
	var result []target.RemoteDocument
	managed := map[string]bool{}
	for _, p := range all {
		prop, ok, err := c.managedProperty(ctx, p.ID)
		if err != nil {
			return nil, fmt.Errorf("get property for page %s: %w", p.ID, err)
		}
		if !ok || prop.Value.Namespace != scope.Namespace {
			continue
		}
		managed[p.ID] = true
		metadata := prop.Value
		if metadata.RendererVersion != rendererVersion {
			metadata.DocumentHash = ""
		}
		title := strings.TrimSuffix(p.Title, identityTitleSuffix(prop.Value.Namespace, prop.Value.DocumentID))
		result = append(result, target.RemoteDocument{
			ID: p.ID, Title: title, ParentID: p.ParentID, Version: p.Version.Number,
			PropertyID: prop.ID, PropertyVersion: prop.Version.Number, Metadata: metadata,
		})
	}
	c.mu.Lock()
	c.allPages = all
	c.managed = managed
	c.mu.Unlock()
	return result, nil
}

func (c *Client) CreateSkeleton(ctx context.Context, m target.Mutation) (target.RemoteDocument, error) {
	pendingTitle, pendingBody := pendingIdentity(m.Scope.Namespace, m.Document.ID)
	c.mu.Lock()
	candidates := []page{}
	for _, existing := range c.allPages {
		if existing.Title == pendingTitle && existing.ParentID == m.ParentRemoteID {
			candidates = append(candidates, existing)
		}
	}
	c.mu.Unlock()
	for _, candidate := range candidates {
		var existing pageWithBody
		if requestErr := c.get(ctx, c.apiV2("/pages/"+url.PathEscape(candidate.ID)+"?body-format=storage"), &existing); requestErr != nil {
			return target.RemoteDocument{}, requestErr
		}
		if existing.Body.Storage.Value == pendingBody {
			return c.claimSkeleton(ctx, m, existing.page)
		}
	}
	if len(candidates) > 0 {
		return target.RemoteDocument{}, errors.New("pending page title exists without the expected ownership marker")
	}
	body := map[string]any{
		"spaceId": m.Scope.SpaceID, "status": "current", "title": pendingTitle,
		"parentId": m.ParentRemoteID,
		"body":     map[string]string{"representation": "storage", "value": pendingBody},
	}
	var created page
	if requestErr := c.send(ctx, http.MethodPost, c.apiV2("/pages"), body, &created); requestErr != nil {
		return target.RemoteDocument{}, requestErr
	}
	return c.claimSkeleton(ctx, m, created)
}

func (c *Client) claimSkeleton(ctx context.Context, m target.Mutation, created page) (target.RemoteDocument, error) {
	metadata := metadataFor(m, "", created.Version.Number)
	prop, err := c.createProperty(ctx, created.ID, metadata)
	if err != nil {
		ownershipErr := fmt.Errorf("record ownership for page %s: %w", created.ID, err)
		cleanupErr := c.send(ctx, http.MethodDelete, c.apiV2("/pages/"+url.PathEscape(created.ID)), nil, nil)
		if cleanupErr != nil {
			return target.RemoteDocument{}, errors.Join(ownershipErr, fmt.Errorf("delete orphan page %s: %w", created.ID, cleanupErr))
		}
		return target.RemoteDocument{}, ownershipErr
	}
	if labelErr := c.ensureLabels(ctx, created.ID); labelErr != nil {
		return target.RemoteDocument{}, labelErr
	}
	return target.RemoteDocument{ID: created.ID, Title: created.Title, ParentID: created.ParentID, Version: created.Version.Number, PropertyID: prop.ID, PropertyVersion: prop.Version.Number, Metadata: metadata}, nil
}

func pendingIdentity(namespace, documentID string) (string, string) {
	sum := sha256.Sum256([]byte(namespace + "\x00" + documentID))
	marker := hex.EncodeToString(sum[:])
	return "docusynx pending " + marker, `<p><code>docusynx-pending:` + marker + `</code></p>`
}

func (c *Client) Update(ctx context.Context, remote target.RemoteDocument, m target.Mutation) (target.RemoteDocument, error) {
	if remote.Metadata.Namespace != m.Scope.Namespace || remote.Metadata.DocumentID != m.Document.ID {
		return target.RemoteDocument{}, errors.New("managed ownership check failed")
	}
	value, err := renderDocument(m.Document, m.SourceURL, m.DocumentIDs, m.AssetFilenames)
	if err != nil {
		return target.RemoteDocument{}, err
	}
	title := c.publishedTitle(remote.ID, m)
	body := map[string]any{
		"id": remote.ID, "status": "current", "title": title, "parentId": m.ParentRemoteID,
		"body":    map[string]string{"representation": "storage", "value": value},
		"version": map[string]any{"number": remote.Version + 1, "message": "Published by docusynx"},
	}
	var updated page
	if requestErr := c.send(ctx, http.MethodPut, c.apiV2("/pages/"+url.PathEscape(remote.ID)), body, &updated); requestErr != nil {
		return target.RemoteDocument{}, requestErr
	}
	c.mu.Lock()
	c.allPages[updated.ID] = updated
	c.mu.Unlock()
	metadata := metadataFor(m, m.Document.Hash, updated.Version.Number)
	// Commit the final managed hash only after every other page mutation has
	// succeeded. A label failure then remains visible as page-version drift.
	if labelErr := c.ensureLabels(ctx, updated.ID); labelErr != nil {
		return target.RemoteDocument{}, labelErr
	}
	prop, err := c.putProperty(ctx, updated.ID, remote.PropertyID, remote.PropertyVersion, metadata)
	if err != nil {
		return target.RemoteDocument{}, err
	}
	return target.RemoteDocument{ID: updated.ID, Title: updated.Title, ParentID: updated.ParentID, Version: updated.Version.Number, PropertyID: prop.ID, PropertyVersion: prop.Version.Number, Metadata: metadata}, nil
}

func (c *Client) publishedTitle(remoteID string, m target.Mutation) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	for id, existing := range c.allPages {
		if id != remoteID && strings.EqualFold(existing.Title, m.Document.Title) {
			suffix := identityTitleSuffix(m.Scope.Namespace, m.Document.ID)
			base := []rune(m.Document.Title)
			limit := 255 - len([]rune(suffix))
			if len(base) > limit {
				base = base[:limit]
			}
			return string(base) + suffix
		}
	}
	return m.Document.Title
}

func identityTitleSuffix(namespace, documentID string) string {
	sum := sha256.Sum256([]byte(namespace + "\x00" + documentID))
	return " · docusynx-" + hex.EncodeToString(sum[:6])
}

func (c *Client) UploadAsset(ctx context.Context, remote target.RemoteDocument, asset target.Asset) error {
	if remote.Metadata.DocumentID == "" {
		return errors.New("refusing to upload an asset to an unmanaged page")
	}
	var response struct {
		Results []struct {
			ID      string `json:"id"`
			Title   string `json:"title"`
			Comment string `json:"comment"`
		} `json:"results"`
	}
	if requestErr := c.get(ctx, c.apiV2("/pages/"+url.PathEscape(remote.ID)+"/attachments?limit=250"), &response); requestErr != nil {
		return requestErr
	}
	attachmentID := ""
	for _, attachment := range response.Results {
		if attachment.Title == asset.Filename {
			if attachment.Comment == asset.Hash {
				return nil
			}
			attachmentID = attachment.ID
			break
		}
	}
	file, err := os.Open(asset.Path)
	if err != nil {
		return err
	}
	defer file.Close()
	var requestBody bytes.Buffer
	writer := multipart.NewWriter(&requestBody)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", mime.FormatMediaType("form-data", map[string]string{"name": "file", "filename": asset.Filename}))
	header.Set("Content-Type", asset.MIMEType)
	part, err := writer.CreatePart(header)
	if err != nil {
		return err
	}
	if _, copyErr := io.Copy(part, file); copyErr != nil {
		return copyErr
	}
	_ = writer.WriteField("comment", asset.Hash)
	_ = writer.WriteField("minorEdit", "true")
	if closeErr := writer.Close(); closeErr != nil {
		return closeErr
	}
	endpoint := c.apiV1("/content/" + url.PathEscape(remote.ID) + "/child/attachment")
	if attachmentID != "" {
		endpoint += "/" + url.PathEscape(attachmentID) + "/data"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, &requestBody)
	if err != nil {
		return err
	}
	req.SetBasicAuth(c.email, c.token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("X-Atlassian-Token", "nocheck")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("Confluence attachment upload returned %s: %s", resp.Status, strings.TrimSpace(string(message)))
	}
	return nil
}

func (c *Client) ReconcileAssets(ctx context.Context, remote target.RemoteDocument, desired []target.Asset) error {
	if remote.Metadata.DocumentID == "" {
		return errors.New("refusing to reconcile assets on an unmanaged page")
	}
	wanted := make(map[string]bool, len(desired))
	for _, asset := range desired {
		wanted[asset.Filename] = true
	}
	var response struct {
		Results []struct {
			ID    string `json:"id"`
			Title string `json:"title"`
		} `json:"results"`
	}
	if requestErr := c.get(ctx, c.apiV2("/pages/"+url.PathEscape(remote.ID)+"/attachments?limit=250"), &response); requestErr != nil {
		return requestErr
	}
	for _, attachment := range response.Results {
		if strings.HasPrefix(attachment.Title, "docusynx-") && !wanted[attachment.Title] {
			if deleteErr := c.send(ctx, http.MethodDelete, c.apiV2("/attachments/"+url.PathEscape(attachment.ID)), nil, nil); deleteErr != nil {
				return deleteErr
			}
		}
	}
	return nil
}

func (c *Client) Delete(ctx context.Context, scope target.Scope, remote target.RemoteDocument) error {
	currentDocuments, err := c.Discover(ctx, scope)
	if err != nil {
		return err
	}
	var current *target.RemoteDocument
	for i := range currentDocuments {
		if currentDocuments[i].ID == remote.ID {
			current = &currentDocuments[i]
			break
		}
	}
	if current == nil || current.Metadata.Namespace != scope.Namespace || current.Metadata.DocumentID != remote.Metadata.DocumentID {
		return errors.New("refusing to delete a page without matching current managed ownership")
	}
	if current.Version != remote.Version || current.PropertyID != remote.PropertyID || current.PropertyVersion != remote.PropertyVersion {
		return fmt.Errorf("refusing to delete page %s because its version or ownership property changed", remote.ID)
	}
	c.mu.Lock()
	for id, p := range c.allPages {
		if p.ParentID == remote.ID && !c.managed[id] {
			c.mu.Unlock()
			return fmt.Errorf("refusing to delete page %s because it has unmanaged child %s", remote.ID, id)
		}
	}
	c.mu.Unlock()
	return c.send(ctx, http.MethodDelete, c.apiV2("/pages/"+url.PathEscape(remote.ID)), nil, nil)
}

func metadataFor(m target.Mutation, hash string, version int) target.ManagedMetadata {
	return target.ManagedMetadata{Namespace: m.Scope.Namespace, DocumentID: m.Document.ID, DocumentHash: hash, ParentDocument: m.Document.ParentID, SourcePath: m.Document.Source.Path, SourceURL: m.SourceURL, SourceCommit: m.Document.Source.Commit, RendererVersion: rendererVersion, PageVersion: version}
}

func (c *Client) managedProperty(ctx context.Context, pageID string) (property, bool, error) {
	var response struct {
		Results []property `json:"results"`
	}
	endpoint := c.apiV2("/pages/" + url.PathEscape(pageID) + "/properties?key=" + url.QueryEscape(propertyKey) + "&limit=2")
	if requestErr := c.get(ctx, endpoint, &response); requestErr != nil {
		return property{}, false, requestErr
	}
	if len(response.Results) == 0 {
		return property{}, false, nil
	}
	if len(response.Results) > 1 {
		return property{}, false, errors.New("multiple managed properties found")
	}
	return response.Results[0], true, nil
}

func (c *Client) createProperty(ctx context.Context, pageID string, metadata target.ManagedMetadata) (property, error) {
	var response property
	err := c.send(ctx, http.MethodPost, c.apiV2("/pages/"+url.PathEscape(pageID)+"/properties"), map[string]any{"key": propertyKey, "value": metadata}, &response)
	return response, err
}

func (c *Client) putProperty(ctx context.Context, pageID, propertyID string, version int, metadata target.ManagedMetadata) (property, error) {
	if propertyID == "" {
		return c.createProperty(ctx, pageID, metadata)
	}
	var response property
	body := map[string]any{"key": propertyKey, "value": metadata, "version": map[string]int{"number": version + 1}}
	err := c.send(ctx, http.MethodPut, c.apiV2("/pages/"+url.PathEscape(pageID)+"/properties/"+url.PathEscape(propertyID)), body, &response)
	return response, err
}

func (c *Client) ensureLabels(ctx context.Context, pageID string) error {
	labels := []map[string]string{{"prefix": "global", "name": "autogenerated"}, {"prefix": "global", "name": "docusynx-managed"}}
	return c.send(ctx, http.MethodPost, c.apiV1("/content/"+url.PathEscape(pageID)+"/label"), labels, nil)
}

func (c *Client) apiV2(path string) string {
	return strings.TrimSuffix(c.base.String(), "/") + "/wiki/api/v2" + path
}

func (c *Client) apiV1(path string) string {
	return strings.TrimSuffix(c.base.String(), "/") + "/wiki/rest/api" + path
}

func (c *Client) nextURL(next string) (string, error) {
	if next == "" {
		return "", nil
	}
	u, err := url.Parse(next)
	if err != nil {
		return "", err
	}
	if !u.IsAbs() {
		basePath := strings.TrimSuffix(c.base.Path, "/")
		if basePath != "" && strings.HasPrefix(u.Path, "/wiki/") {
			u.Path = basePath + u.Path
		}
		u = c.base.ResolveReference(u)
	}
	if u.Scheme != c.base.Scheme || u.Host != c.base.Host {
		return "", errors.New("Confluence pagination URL changed origin")
	}
	return u.String(), nil
}

func (c *Client) get(ctx context.Context, endpoint string, out any) error {
	return c.send(ctx, http.MethodGet, endpoint, nil, out)
}

func (c *Client) send(ctx context.Context, method, endpoint string, body, out any) error {
	var data []byte
	if body != nil {
		var err error
		data, err = json.Marshal(body)
		if err != nil {
			return err
		}
	}
	retryable := method == http.MethodGet || method == http.MethodPut || (method == http.MethodPost && strings.HasSuffix(endpoint, "/label"))
	for attempt := 0; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(data))
		if err != nil {
			return err
		}
		req.SetBasicAuth(c.email, c.token)
		req.Header.Set("Accept", "application/json")
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		response, err := c.httpClient.Do(req)
		if err != nil {
			if retryable && attempt < 2 {
				if waitErr := waitRetry(ctx, attempt, ""); waitErr != nil {
					return waitErr
				}
				continue
			}
			return err
		}
		if response.StatusCode >= 200 && response.StatusCode < 300 {
			defer response.Body.Close()
			if out == nil {
				_, _ = io.Copy(io.Discard, response.Body)
				return nil
			}
			if decodeErr := json.NewDecoder(io.LimitReader(response.Body, 16<<20)).Decode(out); decodeErr != nil {
				return fmt.Errorf("decode Confluence response: %w", decodeErr)
			}
			return nil
		}
		message, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		response.Body.Close()
		transient := response.StatusCode == http.StatusTooManyRequests || response.StatusCode == 500 || response.StatusCode == 502 || response.StatusCode == 503 || response.StatusCode == 504
		if retryable && transient && attempt < 2 {
			if waitErr := waitRetry(ctx, attempt, response.Header.Get("Retry-After")); waitErr != nil {
				return waitErr
			}
			continue
		}
		return fmt.Errorf("Confluence %s %s returned %s: %s", method, req.URL.Path, response.Status, strings.TrimSpace(string(message)))
	}
}

func waitRetry(ctx context.Context, attempt int, retryAfter string) error {
	delay := time.Duration(100*(1<<attempt)) * time.Millisecond
	if seconds, parseErr := strconv.Atoi(retryAfter); parseErr == nil && seconds >= 0 {
		delay = time.Duration(seconds) * time.Second
	}
	if when, parseErr := http.ParseTime(retryAfter); parseErr == nil {
		if until := time.Until(when); until > 0 {
			delay = until
		}
	}
	if delay > 5*time.Second {
		delay = 5 * time.Second
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
