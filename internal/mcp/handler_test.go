package mcp

import (
	"slices"
	"testing"
)

// The tool list is umm's contract with every agent connected to it. A bare count
// only says something changed; naming the surface says what, so a tool removed by
// accident fails as loudly as one added.
func TestToolDefinitionsAreStable(t *testing.T) {
	want := []string{
		"capture_thought",
		"connect_notes",
		"create_note",
		"find_contradictions",
		"find_open_questions",
		"get_connections",
		"get_related_notes",
		"list_clusters",
		"list_dreams",
		"list_notes",
		"list_spaces",
		"search_notes",
	}
	tools := toolDefinitions()
	got := make([]string, 0, len(tools))
	for _, tool := range tools {
		name, ok := tool["name"].(string)
		if !ok || name == "" {
			t.Fatalf("a tool has no name: %v", tool)
		}
		got = append(got, name)
	}
	if !slices.Equal(got, want) {
		t.Fatalf("tool surface changed\n  got:  %v\n  want: %v", got, want)
	}
	// Sorted, so a client listing them gets a stable order across releases.
	if !slices.IsSorted(got) {
		t.Fatalf("tools are not sorted: %v", got)
	}
}

// Every tool has to describe itself well enough for an agent to choose it
// without trial and error.
func TestEveryToolIsDescribed(t *testing.T) {
	for _, tool := range toolDefinitions() {
		name := tool["name"].(string)
		description, _ := tool["description"].(string)
		if len(description) < 20 {
			t.Errorf("%s has no usable description: %q", name, description)
		}
		if _, ok := tool["inputSchema"]; !ok {
			t.Errorf("%s has no input schema", name)
		}
	}
}
