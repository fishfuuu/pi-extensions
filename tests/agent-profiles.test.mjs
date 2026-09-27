// Static contract for the canonical Pi Web custom agent profiles.
//
// These assertions exist to stop silent drift: a legacy pi-subagents field coming back, a
// profile accidentally gaining write/edit, a model pin disappearing, or browser QA losing
// extension access. They read the canonical files only; they do not touch ~/.pi/agent.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentsDir = path.join(root, "agents");

/** Minimal frontmatter reader: returns the `key: value` pairs between the leading `---` fences. */
function readFrontmatter(file) {
  const text = fs.readFileSync(file, "utf8");
  assert.equal(text.startsWith("---\n"), true, `${file} must start with YAML frontmatter`);
  const end = text.indexOf("\n---\n", 3);
  assert.notEqual(end, -1, `${file} frontmatter must be closed`);
  const fields = {};
  for (const line of text.slice(4, end + 1).split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (match) fields[match[1]] = match[2].trim();
  }
  return fields;
}

const expected = {
  "independent-reviewer": {
    tools: "read, grep, find",
    model: "openai-codex/gpt-5.6-sol",
    thinking: "high",
    loadExtensions: "false",
  },
  "code-reviewer": {
    tools: "read, grep, find, bash",
    model: "ollama/deepseek-v4.1-flash",
    thinking: "high",
    loadExtensions: "false",
  },
  "change-architecture-reviewer": {
    tools: "read, grep, find, bash",
    model: "ollama/deepseek-v4.1-flash",
    thinking: "high",
    loadExtensions: "false",
  },
  "execution-verifier": {
    tools: "read, grep, find, bash",
    model: "ollama/deepseek-v4.1-flash",
    thinking: "high",
    loadExtensions: "false",
  },
  "browser-qa-agent": {
    tools: "read, grep, find",
    model: "ollama/glm-5.3-flash",
    thinking: "high",
    loadExtensions: "true",
  },
};

// Only these keys may appear in canonical frontmatter. The set is Pi Web's schema; the
// pi-subagents keys are listed so their reintroduction fails loudly instead of silently.
const allowedKeys = new Set([
  "name",
  "description",
  "tools",
  "model",
  "thinking",
  "prompt_mode",
  "inherit_context",
  "load_skills",
  "load_extensions",
  "run_in_background",
]);

const legacyKeys = [
  "systemPromptMode",
  "inheritProjectContext",
  "inheritGlobalContext",
  "inheritSkills",
  "acceptanceRole",
  "completionGuard",
  "defaultContext",
  "defaultReads",
  "defaultProgress",
  "output",
  "outputMode",
  "aliases",
  "runner",
  "async",
];

const names = Object.keys(expected);
assert.deepEqual(
  fs.readdirSync(agentsDir).filter((name) => name.endsWith(".md")).sort(),
  [...names.map((name) => `${name}.md`), "README.md"].sort(),
  "agents/ must contain exactly the five profiles plus README.md",
);

const seenNames = new Set();
for (const name of names) {
  const file = path.join(agentsDir, `${name}.md`);
  const fields = readFrontmatter(file);

  assert.equal(fields.name, name, `${name}.md: frontmatter name must match the file name`);
  assert.equal(seenNames.has(fields.name), false, `${name}.md: duplicate profile name`);
  seenNames.add(fields.name);

  for (const key of Object.keys(fields)) {
    assert.equal(allowedKeys.has(key), true, `${name}.md: unexpected frontmatter key '${key}'`);
  }
  for (const key of legacyKeys) {
    assert.equal(
      Object.hasOwn(fields, key),
      false,
      `${name}.md: legacy pi-subagents key '${key}' must not return`,
    );
  }

  // Runtime contract, pinned.
  assert.equal(fields.prompt_mode, "replace", `${name}.md: prompt_mode must stay 'replace'`);
  assert.equal(fields.inherit_context, "false", `${name}.md: inherit_context must stay false`);
  assert.equal(fields.load_skills, "false", `${name}.md: load_skills must stay false`);
  assert.equal(fields.tools, expected[name].tools, `${name}.md: tool surface changed`);
  assert.equal(fields.model, expected[name].model, `${name}.md: model pin changed`);
  assert.equal(fields.thinking, expected[name].thinking, `${name}.md: thinking pin changed`);
  assert.equal(
    fields.load_extensions,
    expected[name].loadExtensions,
    `${name}.md: load_extensions changed`,
  );

  // Reviewers and the verifier are read-only; browser QA also must not gain write access.
  for (const forbidden of ["write", "edit"]) {
    assert.equal(
      (fields.tools ?? "").split(",").map((tool) => tool.trim()).includes(forbidden),
      false,
      `${name}.md: '${forbidden}' must not be granted`,
    );
  }

  // The explicit project-context policy is what makes governance reach these agents, because
  // Pi Web child sessions are created with noContextFiles: true and prompt_mode: replace keeps
  // only the profile body.
  const body = fs.readFileSync(file, "utf8");
  assert.match(body, /## Project instruction files/, `${name}.md: missing context policy section`);
  assert.match(
    body,
    /operator-level Pi instruction file/,
    `${name}.md: context policy must name the operator-level instruction file`,
  );
  assert.match(
    body,
    /Do not obtain or request the parent session's conversation/,
    `${name}.md: context policy must exclude the parent conversation`,
  );
}

// Documentation must be excluded from installation: Pi Web turns every *.md in the target
// directory into a profile, so a copied README.md would register a bogus agent.
const agentsReadme = fs.readFileSync(path.join(agentsDir, "README.md"), "utf8");
assert.equal(
  agentsReadme.startsWith("---"),
  false,
  "agents/README.md must stay a plain document, not a profile",
);
assert.match(
  agentsReadme,
  /Where-Object Name -ne 'README\.md'/,
  "agents/README.md must document an install command that excludes itself",
);

console.log(`agent-profiles: ${names.length} canonical profiles verified`);
