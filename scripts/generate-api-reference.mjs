#!/usr/bin/env node
// Regenerates the API reference from the ADSMCP code:
//   node scripts/generate-api-reference.mjs <path-to-ADSMCP-checkout>
//
// - api-reference/openapi.json: the spec the service serves at GET /api/v1/openapi.json
//   (services/mcp/src/openapi-spec.mjs), with the public server URL filled in.
// - one page per public tool under api-reference/<group>/<tool-name>.mdx.
// - "not supported yet" stubs for the old pages listed in scripts/unsupported-tools.json.
// - the "API Reference" tab of docs.json and the redirects from old tool pages.
// Operator-only tools (governance check_*) are never public, so they never get a page.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.argv[2];
if (!repo) {
  console.error("usage: node scripts/generate-api-reference.mjs <path-to-ADSMCP-checkout>");
  process.exit(1);
}
const docsRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const src = (file) => pathToFileURL(path.join(repo, "services/mcp/src", file)).href;

const { buildOpenApiSpec } = await import(src("openapi-spec.mjs"));
const { getPublicToolDefinitions } = await import(src("tool-registry.mjs"));
const { aliasesFor, resolveToolName } = await import(src("tool-catalog/aliases.mjs"));
const { isGatedWriteTool, isDeleteTool } = await import(src("write-gate.mjs"));
const { ENABLE_TOOLS } = await import(src("enable-spend-cap.mjs"));
const { BUDGET_FIELDS } = await import(src("spend-cap.mjs"));
const { ROUTER_PREFIX } = await import(src("mcp/tool-surface.mjs"));

const MCP_HOST = "https://mcp.adsmcp.si";
const DASHBOARD = "https://adsmcp.si/dashboard";
const tools = getPublicToolDefinitions();
const toolByName = new Map(tools.map((tool) => [tool.name, tool]));

// Tools registered under the "meta" platform that are not Meta-specific.
const GENERAL = new Set([
  "start_here", "list_what_i_can_do", "diagnose_my_setup", "preflight_campaign", "validate_campaign_draft",
  "why_did_this_fail", "get_campaign_spec", "suggest_next_action", "whats_changed_since_last_visit",
  "weekly_opportunities", "usage_value_summary", "get_connections_status", "list_connected_accounts",
  "get_usage_status", "sync_brand_context", "sync_strategy_context", "record_learning", "list_community_plugins",
]);
const ANALYSIS = new Set([
  "audit_conversion_tracking", "analyze_cross_platform_performance", "competitor_ads_research",
  "generate_ad_copy_ideas", "generate_performance_brief", "generate_cross_platform_report", "export_report_csv",
  "export_report_google_sheets", "analyze_budget_pacing",
]);
const MONITORING = new Set([
  "create_monitor", "list_monitors", "manage_monitor", "test_monitor", "get_monitor_history", "delete_monitor",
  "save_custom_dashboard_view", "schedule_brief", "list_scheduled_tasks", "manage_scheduled_task",
  "create_automation_rule", "list_automation_rules", "test_automation_rule", "list_pending_actions", "manage_action",
  "resume_workflow_after_approval", "list_execution_queue", "list_dead_letter_queue", "resolve_dead_letter_action",
  "execute_queued_action", "retry_queued_action", "get_action_audit", "get_recent_errors", "get_request_trace",
  "search_service_events", "list_workflow_runs",
]);

const GROUPS = [
  { dir: "general", label: "General", icon: "compass" },
  { dir: "analysis", label: "Reports & analysis", icon: "chart-line" },
  { dir: "monitoring", label: "Monitors, approvals & diagnostics", icon: "bell" },
  { dir: "google-ads", label: "Google Ads", icon: "google", platform: "google" },
  { dir: "meta-ads", label: "Meta Ads", icon: "meta", platform: "meta" },
  { dir: "amazon-ads", label: "Amazon Ads", icon: "amazon", platform: "amazon" },
  { dir: "tiktok-ads", label: "TikTok Ads", icon: "tiktok", platform: "tiktok" },
  { dir: "linkedin-ads", label: "LinkedIn Ads", icon: "linkedin", platform: "linkedin" },
  { dir: "chatgpt-ads", label: "ChatGPT Ads", icon: "message", platform: "chatgpt" },
  { dir: "google-analytics", label: "Google Analytics 4", icon: "chart-simple", platform: "google_analytics" },
  { dir: "klaviyo", label: "Klaviyo", icon: "envelope", platform: "klaviyo" },
];
const PLATFORM_LABEL = {
  meta: "Meta Ads", google: "Google Ads", tiktok: "TikTok Ads", amazon: "Amazon Ads", linkedin: "LinkedIn Ads",
  chatgpt: "ChatGPT Ads", google_analytics: "Google Analytics 4", klaviyo: "Klaviyo", governance: "ADSMCP",
};

function groupDirFor(tool) {
  if (GENERAL.has(tool.name)) return "general";
  if (ANALYSIS.has(tool.name)) return "analysis";
  if (MONITORING.has(tool.name)) return "monitoring";
  if (tool.platform === "governance") return "general";
  const group = GROUPS.find((entry) => entry.platform === tool.platform);
  if (!group) throw new Error(`no docs group for platform ${tool.platform} (${tool.name})`);
  return group.dir;
}

const kebab = (name) => name.replace(/_/g, "-");
const pagePath = (tool) => `api-reference/${groupDirFor(tool)}/${kebab(tool.name)}`;
const link = (name) => (toolByName.has(name) ? `[\`${name}\`](/${pagePath(toolByName.get(name))})` : `\`${name}\``);
const yamlString = (text) => JSON.stringify(String(text).replace(/\s+/g, " ").trim());
const firstSentence = (text) => {
  const clean = String(text).replace(/\s+/g, " ").trim();
  const match = clean.match(/^(.{20,200}?[.!?])(\s|$)/);
  return match ? match[1] : clean.slice(0, 200);
};
// MDX treats { } < > as syntax; tool descriptions are plain text.
const mdxText = (text) => String(text).replace(/\s+/g, " ").trim().replace(/[{}<>]/g, (ch) => `\\${ch}`);

const LOCAL_CONTEXT_WRITES = new Set(["sync_brand_context", "sync_strategy_context", "record_learning"]);
const REFUSED_CONTROL = new Set(["execute_queued_action", "retry_queued_action", "resume_workflow_after_approval"]);
const STAGES_ON_TRIGGER = new Set(["test_monitor", "test_automation_rule", "optimize_budget"]);

function affectsSpend(name) {
  return (
    Object.hasOwn(ENABLE_TOOLS, name) ||
    Object.hasOwn(BUDGET_FIELDS, name) ||
    /^(enable|resume)_/.test(name) ||
    /budget/.test(name) ||
    /^bulk_update_.*_status$/.test(name) ||
    ["update_campaign", "update_amazon_campaigns", "update_meta_campaign"].includes(name)
  );
}
const createsPaused = (name) =>
  /^create_/.test(name) && /(campaign|ad_set|adgroup|ad_group|_ad|creative)$/.test(name) && !/campaign_group$/.test(name);

function safetyBlock(tool) {
  const { name, mode } = tool;
  if (mode === "read") {
    return "<Info>\n**Read-only.** Runs right away and changes nothing in your ad accounts. It still needs a connected platform (check `get_connections_status`) and counts as one tool call.\n</Info>";
  }
  if (REFUSED_CONTROL.has(name)) {
    return `<Warning>\n**Always refused over MCP and REST** with \`approval_requires_dashboard\`. Only a person can approve, run or retry a change, on the dashboard [Approvals](${DASHBOARD}/approvals) page. This tool exists so an AI client gets a clear answer instead of an unknown-tool error.\n</Warning>`;
  }
  if (name === "manage_action") {
    return `<Warning>\n**View or reject only.** \`decision\` can be \`view\` or \`reject\`. An \`approve\` decision is refused with \`approval_requires_dashboard\`: only a person approves, on the dashboard [Approvals](${DASHBOARD}/approvals) page.\n</Warning>`;
  }
  if (STAGES_ON_TRIGGER.has(name)) {
    return `<Info>\n**Never changes an ad account by itself.** If it finds a change to make, it stages a pending action; a person must approve it on the dashboard [Approvals](${DASHBOARD}/approvals) page before anything runs.\n</Info>`;
  }
  if (mode === "control" || name === "delete_monitor") {
    const lines = ["<Info>", "**ADSMCP setting.** Reads or changes ADSMCP's own records (monitors, schedules, rules, queue views). It does not change an ad account."];
    if (isDeleteTool(name)) lines.push("", "Deleting needs `confirm_delete: true`; without it the call is refused.");
    lines.push("</Info>");
    return lines.join("\n");
  }
  if (LOCAL_CONTEXT_WRITES.has(name)) {
    return "<Info>\n**Context file.** Writes ADSMCP context (brand, strategy or learnings) for your AI client. It does not change an ad account.\n</Info>";
  }
  const lines = [
    "<Warning>",
    "**Change — approval required.** Calling this tool does not change your ad account. ADSMCP checks the arguments and stages the change as a pending action. It runs only after a person approves it on the dashboard " +
      `[Approvals](${DASHBOARD}/approvals) page. Over MCP or REST you can view (\`list_pending_actions\`) or reject (\`manage_action\`) it, never approve it. ` +
      "`execution_mode` and similar arguments do not skip the queue.",
  ];
  if (createsPaused(name)) lines.push("", "New campaigns, ad groups, ads and creatives are created paused or as drafts, so nothing starts spending when the approved change runs.");
  if (affectsSpend(name)) {
    lines.push(
      "",
      "**Spend cap.** When the approved change runs, ADSMCP adds up the daily budgets of everything that would be spending in the platform's connected accounts after the change. If that total is above your Max Daily Budget (dashboard [Brand](" +
        `${DASHBOARD}/brand) page), the change is refused. If the total cannot be read, it is refused too.`,
    );
  }
  if (isDeleteTool(name)) {
    lines.push("", "**Delete confirmation.** Pass `confirm_delete: true`. Without it the call is refused and nothing is staged. With it the delete is staged and still needs approval; once approved it cannot be undone.");
  }
  lines.push("", "A change that fails when it runs is not retried automatically. It shows on the dashboard Execution Queue.", "</Warning>");
  return lines.join("\n");
}

// General, analysis and monitoring tools are registered under `meta` but are not Meta-specific.
const platformLabel = (tool) =>
  tool.platform === "meta" && ["general", "analysis", "monitoring"].includes(groupDirFor(tool))
    ? "ADSMCP (registered under `meta`)"
    : (PLATFORM_LABEL[tool.platform] ?? tool.platform);

function toolPage(tool) {
  const restAliases = aliasesFor(tool.name).filter((alias) => resolveToolName(alias, { surface: "rest" }).name === tool.name);
  const kind = tool.mode === "read" ? "Read" : tool.mode === "control" ? "Control" : "Change";
  const parts = [
    "---",
    `title: ${yamlString(tool.name)}`,
    `description: ${yamlString(firstSentence(tool.description))}`,
    `openapi: "/api-reference/openapi.json POST /api/v1/tools/${tool.name}/execute"`,
    "---",
    "",
    "{/* Generated by scripts/generate-api-reference.mjs from the ADSMCP code. Edit the generator, not this file. */}",
    "",
    safetyBlock(tool),
    "",
    mdxText(tool.description),
    "",
    `**Platform:** ${platformLabel(tool)} · **Type:** ${kind}`,
  ];
  if (restAliases.length) {
    parts.push("", `**Also accepted as:** ${restAliases.map((alias) => `\`${alias}\``).join(", ")}. These older names run this same tool.`);
  }
  parts.push(
    "",
    "## How to call it",
    "",
    `- **MCP:** on \`${MCP_HOST}/mcp\`, run it through the \`${ROUTER_PREFIX[tool.platform]}_${tool.mode === "read" ? "read" : "write"}\` tool with \`{"action": "execute", "tool_name": "${tool.name}", "arguments": { ... }}\`, or call \`${tool.name}\` by name. \`search_tools\` finds it and \`get_tool_schema\` returns its arguments; \`${MCP_HOST}/mcp/flat\` lists every tool by name.`,
    `- **REST:** \`POST ${MCP_HOST}/api/v1/tools/${tool.name}/execute\` with \`Authorization: Bearer sk_live_...\` and a JSON body \`{"platform": "${tool.platform}", "arguments": { ... }}\`. The arguments are listed below; they are exactly the tool's input schema.`,
    "",
  );
  return parts.join("\n");
}

function stubPage(oldPage, entry, oldTitle) {
  const alternatives = (entry.use ?? []).filter((name) => toolByName.has(name));
  const missing = (entry.use ?? []).filter((name) => !toolByName.has(name));
  if (missing.length) throw new Error(`${oldPage}: alternatives are not public tools: ${missing.join(", ")}`);
  const lines = [
    "---",
    `title: ${yamlString(oldTitle || entry.tool)}`,
    `description: ${yamlString(`ADSMCP does not support ${entry.tool} yet.`)}`,
    "---",
    "",
    "{/* Generated by scripts/generate-api-reference.mjs from scripts/unsupported-tools.json. */}",
    "",
    "<Warning>",
    `**ADSMCP does not support this tool yet.** \`${entry.tool}\` is not in the ADSMCP tool catalog, so MCP and REST calls to it fail. It is not in the [OpenAPI spec](/api-reference/introduction).`,
    "</Warning>",
    "",
  ];
  if (entry.note) lines.push(entry.note, "");
  if (alternatives.length) {
    lines.push("## Use instead", "", ...alternatives.map((name) => `- ${link(name)} — ${mdxText(firstSentence(toolByName.get(name).description))}`), "");
  } else {
    lines.push("There is no ADSMCP tool for this yet. Make the change in the platform's own ads manager.", "");
  }
  lines.push("See the [API reference overview](/api-reference/introduction) for every tool ADSMCP has.", "");
  return lines.join("\n");
}

// ---- write the spec -------------------------------------------------------------------------------------------
const spec = buildOpenApiSpec();
spec.servers = [{ url: MCP_HOST, description: "ADSMCP MCP and REST service" }];
spec.info.description =
  "ADSMCP REST API: every public ADSMCP tool as POST /api/v1/tools/{name}/execute. Generated from the ADSMCP code " +
  "(the service serves the same document at GET /api/v1/openapi.json). Changes to ad accounts are staged for approval by a person " +
  "on the ADSMCP dashboard; nothing in this API can approve them.";
fs.writeFileSync(path.join(docsRoot, "api-reference/openapi.json"), `${JSON.stringify(spec, null, 2)}\n`);

// ---- remove old generated tool pages, keep hand-written files ---------------------------------------------------
const unsupported = JSON.parse(fs.readFileSync(path.join(docsRoot, "scripts/unsupported-tools.json"), "utf8"));
delete unsupported._comment;
const oldPages = [];
const oldTitles = new Map();
for (const dirent of fs.readdirSync(path.join(docsRoot, "api-reference"), { withFileTypes: true })) {
  if (!dirent.isDirectory()) continue;
  for (const file of fs.readdirSync(path.join(docsRoot, "api-reference", dirent.name))) {
    if (!file.endsWith(".mdx")) continue;
    const rel = `api-reference/${dirent.name}/${file.replace(/\.mdx$/, "")}`;
    const text = fs.readFileSync(path.join(docsRoot, `${rel}.mdx`), "utf8");
    const title = text.match(/^title:\s*"?(.*?)"?\s*$/m)?.[1] ?? "";
    const op = text.match(/(?:post|POST) \/api\/v1\/tools\/([a-z0-9_]+)\/execute/);
    oldPages.push({ rel, name: op ? op[1] : null });
    oldTitles.set(rel, title);
    fs.rmSync(path.join(docsRoot, `${rel}.mdx`));
  }
}

// ---- tool pages -----------------------------------------------------------------------------------------------
const pagesByGroup = new Map(GROUPS.map((group) => [group.dir, { reads: [], changes: [] }]));
for (const tool of tools) {
  const rel = pagePath(tool);
  fs.mkdirSync(path.join(docsRoot, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(docsRoot, `${rel}.mdx`), toolPage(tool));
  pagesByGroup.get(groupDirFor(tool))[tool.mode === "read" ? "reads" : "changes"].push(rel);
}

// ---- stubs ----------------------------------------------------------------------------------------------------
const stubsByDir = new Map();
for (const [rel, entry] of Object.entries(unsupported)) {
  if (toolByName.has(entry.tool)) throw new Error(`${entry.tool} is a public tool now; remove it from unsupported-tools.json`);
  fs.mkdirSync(path.join(docsRoot, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(docsRoot, `${rel}.mdx`), stubPage(rel, entry, oldTitles.get(rel)));
  const dir = rel.split("/")[1];
  if (!stubsByDir.has(dir)) stubsByDir.set(dir, []);
  stubsByDir.get(dir).push(rel);
}

// ---- redirects from old pages ---------------------------------------------------------------------------------
const generatedRedirects = [];
for (const { rel, name } of oldPages) {
  if (Object.hasOwn(unsupported, rel)) continue;
  const resolved = name ? resolveToolName(name, { surface: "rest" }).name : null;
  const tool = resolved ? toolByName.get(resolved) : null;
  if (!tool) throw new Error(`old page ${rel} (${name}) is neither a tool nor listed in unsupported-tools.json`);
  const target = pagePath(tool);
  if (target !== rel) generatedRedirects.push({ source: `/${rel}`, destination: `/${target}` });
}

// ---- docs.json ------------------------------------------------------------------------------------------------
const docsJsonPath = path.join(docsRoot, "docs.json");
const docs = JSON.parse(fs.readFileSync(docsJsonPath, "utf8"));
const groupOf = (group) => {
  const { reads, changes } = pagesByGroup.get(group.dir);
  if (!reads.length && !changes.length) return null;
  const pages = [];
  if (reads.length) pages.push({ group: `${group.label}: reads`, pages: reads });
  if (changes.length) pages.push({ group: `${group.label}: changes & controls`, pages: changes });
  return { group: group.label, icon: group.icon, pages };
};
const dirLabel = Object.fromEntries(GROUPS.map((group) => [group.dir, group.label]));
const apiTab = {
  tab: "API Reference",
  icon: "code",
  groups: [
    { group: "Overview", icon: "book", pages: ["api-reference/introduction"] },
    ...GROUPS.map(groupOf).filter(Boolean),
    {
      group: "Not supported yet",
      icon: "ban",
      pages: [...stubsByDir.entries()].map(([dir, pages]) => ({ group: dirLabel[dir] ?? dir, pages: pages.sort() })),
    },
  ],
};
const tabs = docs.navigation.tabs.filter((tab) => tab.tab !== "API Reference");
docs.navigation.tabs = [...tabs, apiTab];
// Keep earlier redirects (an old page from a previous run is gone now, but its redirect still matters) unless the
// source is a page again or the destination page no longer exists; new redirects replace ones with the same source.
const pageExists = (route) => fs.existsSync(path.join(docsRoot, `${route.replace(/^\//, "")}.mdx`));
const newSources = new Set(generatedRedirects.map((redirect) => redirect.source));
const kept = (docs.redirects ?? []).filter(
  (redirect) =>
    !newSources.has(redirect.source) &&
    !(redirect.source.startsWith("/api-reference/") && (pageExists(redirect.source) || !pageExists(redirect.destination))),
);
docs.redirects = [...kept, ...generatedRedirects];
fs.writeFileSync(docsJsonPath, `${JSON.stringify(docs, null, 2)}\n`);

console.log(
  `${tools.length} tool pages, ${Object.keys(unsupported).length} not-supported stubs, ${generatedRedirects.length} redirects, ${Object.keys(spec.paths).length} spec paths`,
);
