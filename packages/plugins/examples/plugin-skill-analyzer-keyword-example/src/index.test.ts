/**
 * Unit tests for the skill analyzer keyword heuristic.
 *
 * Three tests per the plan:
 *  1. Task-domain matching: a "write a markdown blog post" task selects
 *     markdown/writing skills and rejects database/SQL skills.
 *  2. Empty input → empty selection.
 *  3. Threshold filtering: a skill below threshold is excluded.
 */
import { describe, expect, it } from "vitest";
import { analyzeTask, selectRelevant, tokenize } from "./index.js";

describe("skill-analyzer-keyword-example", () => {
  // -------------------------------------------------------------------------
  // Test 1: task-domain matching
  // -------------------------------------------------------------------------
  it("selects markdown/blog skills for a blog post task and rejects database/sql skills", () => {
    // Task tokens from "Write a markdown blog post / Draft an article using markdown formatting":
    // write, markdown, blog, post, draft, article, using, formatting, headers, lists
    //
    // "markdown-editing" contains "markdown" → score >= 1 → selected
    // "blog-publishing"  contains "blog"     → score >= 1 → selected
    // "article-draft"    contains "article" and "draft" → score >= 2 → selected
    // "database-query"   no matching tokens  → score 0   → excluded
    // "sql-migration"    no matching tokens  → score 0   → excluded
    const result = analyzeTask({
      taskTitle: "Write a markdown blog post",
      taskBody: "Draft an article using markdown formatting with headers and lists.",
      availableSkills: [
        "markdown-editing",
        "article-draft",
        "database-query",
        "sql-migration",
        "blog-publishing",
      ],
      availableMcpTools: [],
    });

    expect(result.selectedSkills).toContain("markdown-editing");
    expect(result.selectedSkills).toContain("blog-publishing");
    expect(result.selectedSkills).toContain("article-draft");

    // SQL/database skills should NOT be selected (no keyword overlap)
    expect(result.selectedSkills).not.toContain("database-query");
    expect(result.selectedSkills).not.toContain("sql-migration");

    expect(result.rationale).toBeTruthy();
    expect(result.rationale).toMatch(/skill/i);
  });

  // -------------------------------------------------------------------------
  // Test 2: empty input → empty selection
  // -------------------------------------------------------------------------
  it("returns empty selections for empty task and empty catalogs", () => {
    const result = analyzeTask({
      taskTitle: "",
      taskBody: "",
      availableSkills: [],
      availableMcpTools: [],
    });

    expect(result.selectedSkills).toHaveLength(0);
    expect(result.selectedMcpTools).toHaveLength(0);
    expect(result.rationale).toBeTruthy();
  });

  it("returns empty selections when catalogs are empty even with a task", () => {
    const result = analyzeTask({
      taskTitle: "Fix the authentication flow",
      taskBody: "Update the login handler to handle token refresh.",
      availableSkills: [],
      availableMcpTools: [],
    });

    expect(result.selectedSkills).toHaveLength(0);
    expect(result.selectedMcpTools).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 3: threshold filtering
  // -------------------------------------------------------------------------
  it("excludes skills that score below the relevance threshold", () => {
    // Task: write a blog post.
    // "markdown-editing" matches "markdown" and "write" → score 2
    // "coffee-shop" matches nothing relevant → score 0
    // "article-writing" matches "write" → score 1 (meets threshold=1)
    // "database-migration" matches nothing → score 0
    const taskTokens = tokenize("write a markdown blog post article");

    const allSkills = [
      "markdown-editing",    // score >= 2 (markdown + write not in name but markdown is)
      "coffee-shop",         // score 0
      "article-writing",     // matches "write" and "article" → score 2
      "database-migration",  // score 0
    ];

    // With threshold=1 — coffee-shop and database-migration excluded
    const withThreshold1 = selectRelevant(allSkills, taskTokens, { relevanceThreshold: 1 });
    expect(withThreshold1).toContain("markdown-editing");
    expect(withThreshold1).toContain("article-writing");
    expect(withThreshold1).not.toContain("coffee-shop");
    expect(withThreshold1).not.toContain("database-migration");

    // With threshold=3 — very high threshold, nothing should match
    const withHighThreshold = selectRelevant(allSkills, taskTokens, { relevanceThreshold: 3 });
    expect(withHighThreshold).toHaveLength(0);
  });
});
