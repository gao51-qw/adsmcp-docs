#!/usr/bin/env node
// Refreshes the generated tool tables on the platform overview pages:
//   node scripts/platform-pages.mjs        (run after scripts/generate-api-reference.mjs)
// Each page keeps its hand-written text; only the block between the GENERATED markers is replaced. The table lists the
// tools in that platform's API reference group (docs.json), with each tool page's description.

import fs from "node:fs";
import path from "node:path";

const docsRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const START = "{/* GENERATED TOOL TABLE: do not edit by hand; run scripts/platform-pages.mjs */}";
const END = "{/* END GENERATED TOOL TABLE */}";

const PAGES = {
  "ad-platforms/google-ads.mdx": "Google Ads",
  "ad-platforms/meta-ads.mdx": "Meta Ads",
  "ad-platforms/amazon-ads.mdx": "Amazon Ads",
  "ad-platforms/tiktok-ads.mdx": "TikTok Ads",
  "ad-platforms/linkedin-ads.mdx": "LinkedIn Ads",
  "ad-platforms/chatgpt-ads.mdx": "ChatGPT Ads",
  "marketing-stack/google-analytics.mdx": "Google Analytics 4",
  "marketing-stack/klaviyo.mdx": "Klaviyo",
};

const docs = JSON.parse(fs.readFileSync(path.join(docsRoot, "docs.json"), "utf8"));
const apiTab = docs.navigation.tabs.find((tab) => tab.tab === "API Reference");
const frontmatter = (route) => {
  const text = fs.readFileSync(path.join(docsRoot, `${route}.mdx`), "utf8");
  const field = (name) => {
    const raw = text.match(new RegExp(`^${name}:\\s*(.*)$`, "m"))?.[1] ?? "";
    try {
      return JSON.parse(raw);
    } catch {
      return raw.replace(/^"|"$/g, "");
    }
  };
  return { title: field("title"), description: field("description") };
};
const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/[{}<>]/g, (ch) => `\\${ch}`);

function table(label) {
  const group = apiTab.groups.find((entry) => entry.group === label);
  if (!group) throw new Error(`no API reference group ${label}`);
  const lines = [START, ""];
  for (const sub of group.pages) {
    const heading = sub.group.endsWith(": reads") ? "Reads (run right away, change nothing)" : "Changes (staged for approval on the dashboard)";
    lines.push(`### ${heading}`, "", "| Tool | What it does |", "| --- | --- |");
    for (const route of sub.pages) {
      const { title, description } = frontmatter(route);
      lines.push(`| [\`${title}\`](/${route}) | ${cell(description)} |`);
    }
    lines.push("");
  }
  lines.push(END);
  return lines.join("\n");
}

for (const [file, label] of Object.entries(PAGES)) {
  const full = path.join(docsRoot, file);
  const text = fs.readFileSync(full, "utf8").replace(/\r\n/g, "\n");
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start < 0 || end < 0) throw new Error(`${file} has no generated-table markers`);
  fs.writeFileSync(full, text.slice(0, start) + table(label) + text.slice(end + END.length));
}
console.log(`refreshed ${Object.keys(PAGES).length} platform pages`);
