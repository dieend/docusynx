// Package config reads the docusynx publication configuration.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"gopkg.in/yaml.v3"
)

const SchemaVersion = 1

type Config struct {
	SchemaVersion int                    `yaml:"schemaVersion"`
	Targets       map[string]Target      `yaml:"targets"`
	Publications  map[string]Publication `yaml:"publications"`
	path          string
}

type Target struct {
	Type          string `yaml:"type"`
	BaseURLEnv    string `yaml:"baseUrlEnv"`
	EmailEnv      string `yaml:"emailEnv"`
	APITokenEnv   string `yaml:"apiTokenEnv"`
	SpaceIDEnv    string `yaml:"spaceIdEnv"`
	RootPageIDEnv string `yaml:"rootPageIdEnv"`
}

type Publication struct {
	Source            Source   `yaml:"source"`
	TargetRefs        []string `yaml:"targetRefs"`
	Namespace         string   `yaml:"namespace"`
	SourceURLTemplate string   `yaml:"sourceUrlTemplate,omitempty"`
}

type Source struct {
	Bundle string `yaml:"bundle"`
}

func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	var c Config
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	decoder.KnownFields(true)
	if decodeErr := decoder.Decode(&c); decodeErr != nil {
		return nil, fmt.Errorf("decode config: %w", decodeErr)
	}
	c.path, err = filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if validationErr := c.Validate(); validationErr != nil {
		return nil, validationErr
	}
	return &c, nil
}

func (c *Config) Validate() error {
	if c.SchemaVersion != SchemaVersion {
		return fmt.Errorf("unsupported config schemaVersion %d", c.SchemaVersion)
	}
	if len(c.Targets) == 0 || len(c.Publications) == 0 {
		return errors.New("at least one target and publication are required")
	}
	for name, t := range c.Targets {
		if name == "" || t.Type != "confluence-cloud" {
			return fmt.Errorf("target %q: type must be confluence-cloud", name)
		}
		if t.BaseURLEnv == "" || t.EmailEnv == "" || t.APITokenEnv == "" || t.SpaceIDEnv == "" || t.RootPageIDEnv == "" {
			return fmt.Errorf("target %q: all *Env fields are required", name)
		}
	}
	for name, p := range c.Publications {
		if name == "" || p.Source.Bundle == "" || p.Namespace == "" || len(p.TargetRefs) == 0 {
			return fmt.Errorf("publication %q: source.bundle, namespace, and targetRefs are required", name)
		}
		seen := map[string]bool{}
		for _, ref := range p.TargetRefs {
			if _, ok := c.Targets[ref]; !ok {
				return fmt.Errorf("publication %q: unknown target %q", name, ref)
			}
			if seen[ref] {
				return fmt.Errorf("publication %q: duplicate target %q", name, ref)
			}
			seen[ref] = true
		}
	}
	return nil
}

func (c *Config) BundlePath(publication string) (string, error) {
	p, ok := c.Publications[publication]
	if !ok {
		return "", fmt.Errorf("unknown publication %q", publication)
	}
	if filepath.IsAbs(p.Source.Bundle) {
		return p.Source.Bundle, nil
	}
	return filepath.Join(filepath.Dir(c.path), p.Source.Bundle), nil
}

func (c *Config) TargetNames(publication, selected string) ([]string, error) {
	p, ok := c.Publications[publication]
	if !ok {
		return nil, fmt.Errorf("unknown publication %q", publication)
	}
	if selected != "" {
		for _, name := range p.TargetRefs {
			if name == selected {
				return []string{name}, nil
			}
		}
		return nil, fmt.Errorf("target %q is not used by publication %q", selected, publication)
	}
	names := append([]string(nil), p.TargetRefs...)
	sort.Strings(names)
	return names, nil
}

func Env(name string) (string, error) {
	value, ok := os.LookupEnv(name)
	if !ok || value == "" {
		return "", fmt.Errorf("required environment variable %s is not set", name)
	}
	return value, nil
}
