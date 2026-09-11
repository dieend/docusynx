package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/dieend/docusynx/internal/engine"
	"github.com/dieend/docusynx/internal/plan"
	"github.com/dieend/docusynx/pkg/bundle"
	appconfig "github.com/dieend/docusynx/pkg/config"
	"github.com/dieend/docusynx/pkg/target"
	"github.com/dieend/docusynx/targets/confluence"
)

func main() {
	if runErr := run(context.Background(), os.Args[1:]); runErr != nil {
		fmt.Fprintln(os.Stderr, "docusynx:", runErr)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return usageError()
	}
	switch args[0] {
	case "validate":
		return runValidate(args[1:])
	case "plan":
		return runPlan(ctx, args[1:])
	case "apply":
		return runApply(ctx, args[1:])
	case "sync":
		return runSync(ctx, args[1:])
	case "help", "-h", "--help":
		fmt.Print(usage())
		return nil
	default:
		return usageError()
	}
}

func runValidate(args []string) error {
	fs := flag.NewFlagSet("validate", flag.ContinueOnError)
	path := fs.String("bundle", "", "path to manifest.json")
	if parseErr := fs.Parse(args); parseErr != nil {
		return parseErr
	}
	if *path == "" {
		return errors.New("validate requires --bundle")
	}
	b, err := bundle.Load(*path)
	if err != nil {
		return err
	}
	if validationErr := b.ValidateFiles(*path); validationErr != nil {
		return validationErr
	}
	fmt.Printf("valid bundle: %d documents, %d assets, %s\n", len(b.Documents), len(b.Assets), b.Hash)
	return nil
}

type commonFlags struct{ config, publication, target string }

func addCommon(fs *flag.FlagSet) *commonFlags {
	v := &commonFlags{}
	fs.StringVar(&v.config, "config", "", "path to docusynx YAML configuration")
	fs.StringVar(&v.publication, "publication", "", "named publication")
	fs.StringVar(&v.target, "target", "", "optional named target")
	return v
}

func runPlan(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("plan", flag.ContinueOnError)
	common := addCommon(fs)
	out := fs.String("out", "", "path to write the plan")
	if parseErr := fs.Parse(args); parseErr != nil {
		return parseErr
	}
	if common.config == "" || common.publication == "" || *out == "" {
		return errors.New("plan requires --config, --publication, and --out")
	}
	file, err := buildPlans(ctx, *common)
	if err != nil {
		return err
	}
	if writeErr := writeJSON(*out, file); writeErr != nil {
		return writeErr
	}
	printSummary(file)
	return nil
}

func runApply(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("apply", flag.ContinueOnError)
	configPath := fs.String("config", "", "path to docusynx YAML configuration")
	planPath := fs.String("plan", "", "path to plan JSON")
	if parseErr := fs.Parse(args); parseErr != nil {
		return parseErr
	}
	if *configPath == "" || *planPath == "" {
		return errors.New("apply requires --config and --plan")
	}
	var file plan.File
	data, err := os.ReadFile(*planPath)
	if err != nil {
		return err
	}
	if decodeErr := json.Unmarshal(data, &file); decodeErr != nil {
		return fmt.Errorf("decode plan: %w", decodeErr)
	}
	return applyPlans(ctx, *configPath, &file)
}

func runSync(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("sync", flag.ContinueOnError)
	common := addCommon(fs)
	if parseErr := fs.Parse(args); parseErr != nil {
		return parseErr
	}
	if common.config == "" || common.publication == "" {
		return errors.New("sync requires --config and --publication")
	}
	file, err := buildPlans(ctx, *common)
	if err != nil {
		return err
	}
	printSummary(file)
	return applyPlanFile(ctx, common.config, file)
}

func buildPlans(ctx context.Context, flags commonFlags) (*plan.File, error) {
	cfg, err := appconfig.Load(flags.config)
	if err != nil {
		return nil, err
	}
	bundlePath, err := cfg.BundlePath(flags.publication)
	if err != nil {
		return nil, err
	}
	b, err := bundle.Load(bundlePath)
	if err != nil {
		return nil, err
	}
	names, err := cfg.TargetNames(flags.publication, flags.target)
	if err != nil {
		return nil, err
	}
	p := cfg.Publications[flags.publication]
	file := &plan.File{SchemaVersion: plan.SchemaVersion}
	for _, name := range names {
		client, scope, err := targetFromConfig(cfg.Targets[name], p.Namespace)
		if err != nil {
			return nil, fmt.Errorf("target %q: %w", name, err)
		}
		planned, err := (engine.Engine{Target: client}).Plan(ctx, flags.publication, name, p.Namespace, bundlePath, b, scope)
		if err != nil {
			return nil, fmt.Errorf("target %q: %w", name, err)
		}
		file.Plans = append(file.Plans, planned)
	}
	return file, nil
}

func applyPlans(ctx context.Context, configPath string, file *plan.File) error {
	return applyPlanFile(ctx, configPath, file)
}

func applyPlanFile(ctx context.Context, configPath string, file *plan.File) error {
	if file.SchemaVersion != plan.SchemaVersion {
		return fmt.Errorf("unsupported plan file schemaVersion %d", file.SchemaVersion)
	}
	cfg, err := appconfig.Load(configPath)
	if err != nil {
		return err
	}
	for _, p := range file.Plans {
		publication, ok := cfg.Publications[p.Publication]
		if !ok {
			return fmt.Errorf("plan refers to unknown publication %q", p.Publication)
		}
		allowed := false
		for _, ref := range publication.TargetRefs {
			if ref == p.Target {
				allowed = true
			}
		}
		if !allowed {
			return fmt.Errorf("plan target %q is not used by publication %q", p.Target, p.Publication)
		}
		targetConfig, ok := cfg.Targets[p.Target]
		if !ok {
			return fmt.Errorf("plan refers to unknown target %q", p.Target)
		}
		client, scope, err := targetFromConfig(targetConfig, publication.Namespace)
		if err != nil {
			return err
		}
		if scope.Namespace != p.Namespace {
			return fmt.Errorf("plan namespace %q does not match configuration %q", p.Namespace, scope.Namespace)
		}
		b, err := bundle.Load(p.BundlePath)
		if err != nil {
			return err
		}
		if applyErr := (engine.Engine{Target: client}).Apply(ctx, p, b, scope, publication.SourceURLTemplate); applyErr != nil {
			return fmt.Errorf("target %q: %w", p.Target, applyErr)
		}
	}
	return nil
}

func targetFromConfig(c appconfig.Target, namespace string) (target.Target, target.Scope, error) {
	baseURL, err := appconfig.Env(c.BaseURLEnv)
	if err != nil {
		return nil, target.Scope{}, err
	}
	email, err := appconfig.Env(c.EmailEnv)
	if err != nil {
		return nil, target.Scope{}, err
	}
	token, err := appconfig.Env(c.APITokenEnv)
	if err != nil {
		return nil, target.Scope{}, err
	}
	spaceID, err := appconfig.Env(c.SpaceIDEnv)
	if err != nil {
		return nil, target.Scope{}, err
	}
	rootID, err := appconfig.Env(c.RootPageIDEnv)
	if err != nil {
		return nil, target.Scope{}, err
	}
	client, err := confluence.New(confluence.Options{BaseURL: baseURL, Email: email, APIToken: token})
	return client, target.Scope{Namespace: namespace, SpaceID: spaceID, RootPageID: rootID}, err
}

func writeJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	dir := filepath.Dir(path)
	if mkdirErr := os.MkdirAll(dir, 0o755); mkdirErr != nil {
		return mkdirErr
	}
	temp, err := os.CreateTemp(dir, ".docusynx-plan-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	if _, writeErr := temp.Write(data); writeErr != nil {
		temp.Close()
		return writeErr
	}
	if chmodErr := temp.Chmod(0o600); chmodErr != nil {
		temp.Close()
		return chmodErr
	}
	if closeErr := temp.Close(); closeErr != nil {
		return closeErr
	}
	return os.Rename(tempName, path)
}

func printSummary(file *plan.File) {
	for _, p := range file.Plans {
		counts := map[string]int{}
		for _, operation := range p.Operations {
			counts[operation.Type]++
		}
		fmt.Printf("%s/%s: %d create, %d update, %d delete\n", p.Publication, p.Target, counts["create"], counts["update"], counts["delete"])
	}
}

func usageError() error { return errors.New("usage: docusynx <validate|plan|apply|sync> [options]") }
func usage() string {
	return "docusynx validates a document bundle and synchronizes it to named targets.\n\nCommands: validate, plan, apply, sync\n"
}
