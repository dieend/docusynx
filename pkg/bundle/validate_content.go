package bundle

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
)

type inlineNode struct {
	Type     string       `json:"type"`
	Value    *string      `json:"value,omitempty"`
	Marks    []string     `json:"marks,omitempty"`
	Target   *linkTarget  `json:"target,omitempty"`
	Children []inlineNode `json:"children,omitempty"`
}

type linkTarget struct {
	Kind  string `json:"kind"`
	Value string `json:"value"`
}

func validateBlock(raw json.RawMessage, documents, assets map[string]bool) error {
	var header struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &header); err != nil || header.Type == "" {
		return errors.New("valid type is required")
	}
	switch header.Type {
	case "paragraph":
		var value struct {
			Type    string       `json:"type"`
			Inlines []inlineNode `json:"inlines"`
		}
		if err := decodeStrict(raw, &value); err != nil {
			return err
		}
		if value.Inlines == nil {
			return errors.New("paragraph.inlines is required")
		}
		return validateInlines(value.Inlines, documents)
	case "heading":
		var value struct {
			Type    string       `json:"type"`
			Level   int          `json:"level"`
			Inlines []inlineNode `json:"inlines"`
		}
		if err := decodeStrict(raw, &value); err != nil {
			return err
		}
		if value.Level < 1 || value.Level > 6 {
			return fmt.Errorf("heading.level %d is outside 1 through 6", value.Level)
		}
		if value.Inlines == nil {
			return errors.New("heading.inlines is required")
		}
		return validateInlines(value.Inlines, documents)
	case "code":
		var value struct {
			Type     string  `json:"type"`
			Language string  `json:"language,omitempty"`
			Title    string  `json:"title,omitempty"`
			Value    *string `json:"value"`
		}
		if err := decodeStrict(raw, &value); err != nil {
			return err
		}
		if value.Value == nil {
			return errors.New("code.value is required")
		}
		return nil
	case "mermaid":
		var value struct {
			Type  string  `json:"type"`
			Value *string `json:"value"`
		}
		if err := decodeStrict(raw, &value); err != nil {
			return err
		}
		if value.Value == nil {
			return errors.New("mermaid.value is required")
		}
		return nil
	case "list":
		var value struct {
			Type    string              `json:"type"`
			Ordered *bool               `json:"ordered"`
			Items   [][]json.RawMessage `json:"items"`
		}
		if err := decodeStrict(raw, &value); err != nil {
			return err
		}
		if value.Ordered == nil || value.Items == nil {
			return errors.New("list.ordered and list.items are required")
		}
		for i, item := range value.Items {
			if len(item) == 0 {
				return fmt.Errorf("list item %d is empty", i)
			}
			for j, child := range item {
				if err := validateBlock(child, documents, assets); err != nil {
					return fmt.Errorf("list item %d block %d: %w", i, j, err)
				}
			}
		}
		return nil
	case "table":
		var value struct {
			Type   string           `json:"type"`
			Header [][]inlineNode   `json:"header"`
			Rows   [][][]inlineNode `json:"rows"`
		}
		if err := decodeStrict(raw, &value); err != nil {
			return err
		}
		if value.Header == nil || value.Rows == nil {
			return errors.New("table.header and table.rows are required")
		}
		for i, cell := range value.Header {
			if err := validateInlines(cell, documents); err != nil {
				return fmt.Errorf("table header %d: %w", i, err)
			}
		}
		for i, row := range value.Rows {
			if len(row) != len(value.Header) {
				return fmt.Errorf("table row %d has %d cells, want %d", i, len(row), len(value.Header))
			}
			for j, cell := range row {
				if err := validateInlines(cell, documents); err != nil {
					return fmt.Errorf("table row %d cell %d: %w", i, j, err)
				}
			}
		}
		return nil
	case "admonition":
		var value struct {
			Type   string            `json:"type"`
			Kind   string            `json:"kind"`
			Title  string            `json:"title,omitempty"`
			Blocks []json.RawMessage `json:"blocks"`
		}
		if err := decodeStrict(raw, &value); err != nil {
			return err
		}
		if value.Kind == "" || value.Blocks == nil {
			return errors.New("admonition.kind and admonition.blocks are required")
		}
		for i, child := range value.Blocks {
			if err := validateBlock(child, documents, assets); err != nil {
				return fmt.Errorf("admonition block %d: %w", i, err)
			}
		}
		return nil
	case "image":
		var value struct {
			Type    string `json:"type"`
			AssetID string `json:"assetId"`
			Alt     string `json:"alt,omitempty"`
			Title   string `json:"title,omitempty"`
		}
		if err := decodeStrict(raw, &value); err != nil {
			return err
		}
		if !assets[value.AssetID] {
			return fmt.Errorf("image refers to missing asset %q", value.AssetID)
		}
		return nil
	case "thematicBreak":
		var value struct {
			Type string `json:"type"`
		}
		return decodeStrict(raw, &value)
	case "extension":
		return errors.New("extension blocks are not supported by the selected target")
	default:
		return fmt.Errorf("unsupported block type %q", header.Type)
	}
}

func validateInlines(values []inlineNode, documents map[string]bool) error {
	for i, value := range values {
		switch value.Type {
		case "text":
			if value.Value == nil {
				return fmt.Errorf("inline %d: text.value is required", i)
			}
			if value.Target != nil || value.Children != nil {
				return fmt.Errorf("inline %d: text has link fields", i)
			}
			seen := map[string]bool{}
			for _, mark := range value.Marks {
				if mark != "bold" && mark != "italic" && mark != "strikethrough" && mark != "code" {
					return fmt.Errorf("inline %d: unsupported mark %q", i, mark)
				}
				if seen[mark] {
					return fmt.Errorf("inline %d: duplicate mark %q", i, mark)
				}
				seen[mark] = true
			}
		case "link":
			if value.Value != nil || value.Marks != nil {
				return fmt.Errorf("inline %d: link has text fields", i)
			}
			if value.Target == nil || value.Target.Value == "" || value.Children == nil {
				return fmt.Errorf("inline %d: link.target and link.children are required", i)
			}
			if value.Target.Kind == "document" {
				if !documents[value.Target.Value] {
					return fmt.Errorf("inline %d: link refers to missing document %q", i, value.Target.Value)
				}
			} else if value.Target.Kind != "url" {
				return fmt.Errorf("inline %d: unsupported link target kind %q", i, value.Target.Kind)
			} else if linkErr := validateLinkURL(value.Target.Value); linkErr != nil {
				return fmt.Errorf("inline %d: %w", i, linkErr)
			}
			if err := validateInlines(value.Children, documents); err != nil {
				return fmt.Errorf("inline %d children: %w", i, err)
			}
		default:
			return fmt.Errorf("inline %d: unsupported type %q", i, value.Type)
		}
	}
	return nil
}

func validateLinkURL(value string) error {
	if strings.HasPrefix(value, "#") {
		if len(value) == 1 {
			return errors.New("URL anchor is empty")
		}
		return nil
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return fmt.Errorf("invalid URL: %w", err)
	}
	switch parsed.Scheme {
	case "http", "https":
		if parsed.Host == "" {
			return errors.New("http URL has no host")
		}
	case "mailto":
		if parsed.Opaque == "" && parsed.Path == "" {
			return errors.New("mailto URL has no address")
		}
	default:
		return errors.New("URL must be absolute http/https, mailto, or a same-page anchor")
	}
	return nil
}

func decodeStrict(data []byte, value any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("extra JSON content")
		}
		return err
	}
	return nil
}
