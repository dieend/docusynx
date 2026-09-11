package confluence

import (
	"bytes"
	"encoding/json"
	"fmt"
	"html"
	"net/url"
	"strings"

	"github.com/dieend/docusynx/pkg/bundle"
)

func renderDocument(d bundle.Document, sourceURL string, documentIDs, assetFilenames map[string]string) (string, error) {
	var out bytes.Buffer
	out.WriteString(`<ac:structured-macro ac:name="note"><ac:rich-text-body><p>This page is generated from documentation. Do not edit it directly.`)
	if sourceURL != "" {
		parsed, parseErr := url.Parse(sourceURL)
		if parseErr != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			return "", fmt.Errorf("source URL must be absolute http or https")
		}
		out.WriteString(` <a href="` + html.EscapeString(sourceURL) + `">View the original source</a>.`)
	}
	if d.Source.Commit != "" {
		out.WriteString(` Generated from commit <code>` + html.EscapeString(d.Source.Commit) + `</code>.`)
	}
	out.WriteString(`</p></ac:rich-text-body></ac:structured-macro>`)
	for i, raw := range d.Blocks {
		block, err := renderBlock(raw, documentIDs, assetFilenames)
		if err != nil {
			return "", fmt.Errorf("block %d: %w", i, err)
		}
		out.WriteString(block)
	}
	return out.String(), nil
}

func renderBlock(raw json.RawMessage, documentIDs, assetFilenames map[string]string) (string, error) {
	var header struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &header); err != nil {
		return "", err
	}
	switch header.Type {
	case "paragraph":
		var v struct {
			Inlines []inline `json:"inlines"`
		}
		if err := json.Unmarshal(raw, &v); err != nil {
			return "", err
		}
		body, err := renderInlines(v.Inlines, documentIDs)
		return "<p>" + body + "</p>", err
	case "heading":
		var v struct {
			Level   int      `json:"level"`
			Inlines []inline `json:"inlines"`
		}
		if err := json.Unmarshal(raw, &v); err != nil {
			return "", err
		}
		if v.Level < 1 || v.Level > 6 {
			return "", fmt.Errorf("invalid heading level %d", v.Level)
		}
		body, err := renderInlines(v.Inlines, documentIDs)
		return fmt.Sprintf("<h%d>%s</h%d>", v.Level, body, v.Level), err
	case "code", "mermaid":
		var v struct {
			Language string `json:"language"`
			Title    string `json:"title"`
			Value    string `json:"value"`
		}
		if err := json.Unmarshal(raw, &v); err != nil {
			return "", err
		}
		if header.Type == "mermaid" {
			v.Language = "mermaid"
		}
		var params string
		if v.Language != "" {
			params += `<ac:parameter ac:name="language">` + html.EscapeString(v.Language) + `</ac:parameter>`
		}
		if v.Title != "" {
			params += `<ac:parameter ac:name="title">` + html.EscapeString(v.Title) + `</ac:parameter>`
		}
		return `<ac:structured-macro ac:name="code">` + params + `<ac:plain-text-body><![CDATA[` + cdata(v.Value) + `]]></ac:plain-text-body></ac:structured-macro>`, nil
	case "list":
		var v struct {
			Ordered bool                `json:"ordered"`
			Items   [][]json.RawMessage `json:"items"`
		}
		if err := json.Unmarshal(raw, &v); err != nil {
			return "", err
		}
		tag := "ul"
		if v.Ordered {
			tag = "ol"
		}
		var out strings.Builder
		out.WriteString("<" + tag + ">")
		for _, item := range v.Items {
			out.WriteString("<li>")
			for _, child := range item {
				rendered, err := renderBlock(child, documentIDs, assetFilenames)
				if err != nil {
					return "", err
				}
				out.WriteString(rendered)
			}
			out.WriteString("</li>")
		}
		out.WriteString("</" + tag + ">")
		return out.String(), nil
	case "table":
		var v struct {
			Header [][]inline   `json:"header"`
			Rows   [][][]inline `json:"rows"`
		}
		if err := json.Unmarshal(raw, &v); err != nil {
			return "", err
		}
		var out strings.Builder
		out.WriteString("<table><thead><tr>")
		for _, cell := range v.Header {
			rendered, err := renderInlines(cell, documentIDs)
			if err != nil {
				return "", err
			}
			out.WriteString("<th>" + rendered + "</th>")
		}
		out.WriteString("</tr></thead><tbody>")
		for _, row := range v.Rows {
			out.WriteString("<tr>")
			for _, cell := range row {
				rendered, err := renderInlines(cell, documentIDs)
				if err != nil {
					return "", err
				}
				out.WriteString("<td>" + rendered + "</td>")
			}
			out.WriteString("</tr>")
		}
		out.WriteString("</tbody></table>")
		return out.String(), nil
	case "admonition":
		var v struct {
			Kind   string            `json:"kind"`
			Title  string            `json:"title"`
			Blocks []json.RawMessage `json:"blocks"`
		}
		if err := json.Unmarshal(raw, &v); err != nil {
			return "", err
		}
		name := map[string]string{"note": "note", "info": "info", "tip": "tip", "warning": "warning", "danger": "warning", "quote": "quote"}[v.Kind]
		if name == "" {
			name = "note"
		}
		var out strings.Builder
		out.WriteString(`<ac:structured-macro ac:name="` + name + `">`)
		if v.Title != "" {
			out.WriteString(`<ac:parameter ac:name="title">` + html.EscapeString(v.Title) + `</ac:parameter>`)
		}
		out.WriteString("<ac:rich-text-body>")
		for _, child := range v.Blocks {
			rendered, err := renderBlock(child, documentIDs, assetFilenames)
			if err != nil {
				return "", err
			}
			out.WriteString(rendered)
		}
		out.WriteString("</ac:rich-text-body></ac:structured-macro>")
		return out.String(), nil
	case "image":
		var v struct {
			AssetID string `json:"assetId"`
			Alt     string `json:"alt"`
			Title   string `json:"title"`
		}
		if err := json.Unmarshal(raw, &v); err != nil {
			return "", err
		}
		if v.AssetID == "" {
			return "", fmt.Errorf("image assetId is required")
		}
		filename, ok := assetFilenames[v.AssetID]
		if !ok {
			return "", fmt.Errorf("image refers to missing asset %q", v.AssetID)
		}
		return `<ac:image ac:alt="` + html.EscapeString(v.Alt) + `" ac:title="` + html.EscapeString(v.Title) + `"><ri:attachment ri:filename="` + html.EscapeString(filename) + `" /></ac:image>`, nil
	case "thematicBreak":
		return "<hr />", nil
	case "extension":
		var v struct {
			Name string `json:"name"`
		}
		_ = json.Unmarshal(raw, &v)
		return "", fmt.Errorf("unsupported extension %q", v.Name)
	default:
		return "", fmt.Errorf("unsupported block type %q", header.Type)
	}
}

type inline struct {
	Type   string   `json:"type"`
	Value  string   `json:"value"`
	Marks  []string `json:"marks"`
	Target struct {
		Kind  string `json:"kind"`
		Value string `json:"value"`
	} `json:"target"`
	Children []inline `json:"children"`
}

func renderInlines(values []inline, documentIDs map[string]string) (string, error) {
	var out strings.Builder
	for _, value := range values {
		switch value.Type {
		case "text":
			text := html.EscapeString(value.Value)
			for i := len(value.Marks) - 1; i >= 0; i-- {
				tag := map[string]string{"bold": "strong", "italic": "em", "strikethrough": "s", "code": "code"}[value.Marks[i]]
				if tag == "" {
					return "", fmt.Errorf("unsupported text mark %q", value.Marks[i])
				}
				text = "<" + tag + ">" + text + "</" + tag + ">"
			}
			out.WriteString(text)
		case "link":
			children, err := renderInlines(value.Children, documentIDs)
			if err != nil {
				return "", err
			}
			switch value.Target.Kind {
			case "url":
				out.WriteString(`<a href="` + html.EscapeString(value.Target.Value) + `">` + children + `</a>`)
			case "document":
				id, ok := documentIDs[value.Target.Value]
				if !ok {
					return "", fmt.Errorf("unresolved document link %q", value.Target.Value)
				}
				out.WriteString(`<ac:link><ri:content-entity ri:content-id="` + html.EscapeString(id) + `" /><ac:link-body>` + children + `</ac:link-body></ac:link>`)
			default:
				return "", fmt.Errorf("unsupported link target kind %q", value.Target.Kind)
			}
		default:
			return "", fmt.Errorf("unsupported inline type %q", value.Type)
		}
	}
	return out.String(), nil
}

func cdata(value string) string { return strings.ReplaceAll(value, "]]>", "]]]]><![CDATA[>") }
