package mcp

import "testing"

func TestToolDefinitionsAreStable(t *testing.T) {
	tools := toolDefinitions()
	if len(tools) != 8 {
		t.Fatalf("expected eight tools, got %d", len(tools))
	}
	previous := ""
	for _, tool := range tools {
		name := tool["name"].(string)
		if name < previous {
			t.Fatalf("tools are not sorted: %s before %s", previous, name)
		}
		previous = name
	}
}
