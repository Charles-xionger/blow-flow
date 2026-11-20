package main

import (
	"blow-flow/api/internal/database"
	"blow-flow/api/internal/resource/legacy"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
)

func main() {
	path := flag.String("file", "", "JSON from export_legacy_resources.py")
	owner := flag.String("owner", "", "initial owner user UUID")
	ossHost := flag.String("oss-host", "", "exact trusted OSS hostname for indexing project media URLs")
	apply := flag.Bool("apply", false, "write to PostgreSQL after validation; default is dry run")
	flag.Parse()
	if *path == "" {
		fmt.Fprintln(os.Stderr, "-file is required")
		os.Exit(2)
	}
	content, err := os.ReadFile(*path)
	if err != nil {
		fatal(err)
	}
	var export legacy.Export
	if err = json.Unmarshal(content, &export); err != nil {
		fatal(err)
	}
	if err = export.Validate(); err != nil {
		fatal(err)
	}
	fmt.Printf("validated: projects=%d folders=%d media=%d receipts=%d deletedNodes=%d scriptTasks=%d scriptRequests=%d agentTasks=%d agentMessages=%d agentReceipts=%d agentCanvasReceipts=%d agentBatches=%d skills=%d skillResources=%d skillResourceDigest=%s\n", len(export.Projects), len(export.Folders), len(export.MediaFiles), len(export.SaveReceipts), len(export.DeletedNodes), len(export.ScriptTasks), len(export.ScriptRequests), len(export.AgentTasks), len(export.AgentMessages), len(export.AgentReceipts), len(export.AgentCanvasReceipts), len(export.AgentGenerationBatches), len(export.UserSkills), len(export.UserSkillResources), skillResourceDigest(export.UserSkillResources))
	if !*apply {
		fmt.Println("dry run; PostgreSQL unchanged")
		return
	}
	if *owner == "" || os.Getenv("DATABASE_URL") == "" {
		fatal(fmt.Errorf("-owner and DATABASE_URL are required for -apply"))
	}
	db, pool, err := database.Open(os.Getenv("DATABASE_URL"))
	if err != nil {
		fatal(err)
	}
	defer pool.Close()
	if err = legacy.Apply(context.Background(), db, *owner, *ossHost, export); err != nil {
		fatal(err)
	}
	fmt.Println("import committed")
}
func fatal(err error) { fmt.Fprintln(os.Stderr, err); os.Exit(1) }

func skillResourceDigest(resources []legacy.UserSkillResource) string {
	h := sha256.New()
	for _, r := range resources {
		h.Write([]byte(r.SkillName))
		h.Write([]byte{0})
		h.Write([]byte(r.Path))
		h.Write([]byte{0})
		h.Write([]byte(r.ContentBase64))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))
}
