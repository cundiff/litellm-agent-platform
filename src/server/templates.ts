/**
 * Agent template loader. Two sources, merged at startup:
 *
 * 1. agent_templates.json — flat list, simple templates with no extra files.
 *
 * 2. agent-templates/<id>/ — directory per template. Supports a `files` array
 *    that copies files from the template dir into the sandbox at pod startup.
 *    Each file is base64-encoded into LAP_FILE_N_DEST / LAP_FILE_N_CONTENT
 *    env vars; the harness entrypoint decodes and writes them to disk.
 *
 * Directory templates take precedence over JSON entries with the same id.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface TemplateFile {
  template_path: string;
  sandbox_path: string;
}

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  tags: string[];
  harness_id: string;
  model: string;
  prompt: string;
  skill_name: string;
  skill: string;
  tools: string[];
  requirements: string | null;
  /** Pre-seeded env vars merged into the agent on create (includes encoded files). */
  env_vars: Record<string, string>;
  /** Files to copy into the sandbox — for UI display only. */
  files: TemplateFile[];
}

interface RawTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  tags?: string[];
  harness_id: string;
  model: string;
  prompt?: string;
  skill_name?: string;
  skill?: string;
  tools?: string[];
  requirements?: string | null;
  env_vars?: Record<string, string>;
  files?: TemplateFile[];
}

const ROOT = process.cwd();
const JSON_FILE = join(ROOT, "agent_templates.json");
const DIR_ROOT = join(ROOT, "agent-templates");

function encodeFiles(base: string, files: TemplateFile[]): Record<string, string> {
  const vars: Record<string, string> = {};
  files.forEach(({ template_path, sandbox_path }, i) => {
    try {
      const content = readFileSync(join(base, template_path));
      vars[`LAP_FILE_${i}_DEST`] = sandbox_path;
      vars[`LAP_FILE_${i}_CONTENT`] = content.toString("base64");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[templates] could not read file ${template_path}: ${msg}`);
    }
  });
  return vars;
}

function fromRaw(raw: RawTemplate, base?: string): AgentTemplate {
  const files = raw.files ?? [];
  const fileVars = base ? encodeFiles(base, files) : {};
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    icon: raw.icon,
    tags: raw.tags ?? [],
    harness_id: raw.harness_id,
    model: raw.model,
    prompt: raw.prompt ?? "",
    skill_name: raw.skill_name ?? "",
    skill: raw.skill ?? "",
    tools: raw.tools ?? [],
    requirements: raw.requirements ?? null,
    env_vars: { ...raw.env_vars, ...fileVars },
    files,
  };
}

function loadFromJson(): AgentTemplate[] {
  try {
    const raw: RawTemplate[] = JSON.parse(readFileSync(JSON_FILE, "utf8"));
    return raw.map((t) => fromRaw(t));
  } catch {
    return [];
  }
}

function loadFromDirs(): AgentTemplate[] {
  let dirs: string[];
  try {
    dirs = readdirSync(DIR_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  const out: AgentTemplate[] = [];
  for (const dir of dirs) {
    const base = join(DIR_ROOT, dir);
    try {
      const raw: RawTemplate = JSON.parse(readFileSync(join(base, "template.json"), "utf8"));
      out.push(fromRaw(raw, base));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[templates] skipping ${dir}: ${msg}`);
    }
  }
  return out;
}

function loadTemplates(): AgentTemplate[] {
  const fromJson = loadFromJson();
  const fromDirs = loadFromDirs();
  // Directory templates win on id collision.
  const dirIds = new Set(fromDirs.map((t) => t.id));
  return [...fromJson.filter((t) => !dirIds.has(t.id)), ...fromDirs];
}

const TEMPLATES: AgentTemplate[] = loadTemplates();

export function listTemplates(): AgentTemplate[] {
  return TEMPLATES;
}

export function getTemplate(id: string): AgentTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
