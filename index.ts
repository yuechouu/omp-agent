/**
 * Oh My Pi Mode + Skill + Extension Management System
 *
 * Ported from pi-mode for Oh My Pi compatibility.
 *
 * Features:
 * - /mode command to switch modes
 * - System prompt role replacement per mode
 * - System prompt cleanup: remove inactive mode extension_context tags
 * - Skill filtering (global + all base + current mode)
 * - Tool filtering via setActiveTools() on mode switch
 * - skill_install / extension_install tools with interactive location selection
 * - isActiveForMode() helper for other extensions
 *
 * Extension Context Marking Protocol:
 *   Other extensions can wrap their system prompt injections with mode tags:
 *     <extension_context mode="coding,research">...content...</extension_context>
 *   The mode extension removes content from inactive modes on switch.
 *   mode="all" or no mode attribute = always active.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Constants — configurable via environment variables
// ---------------------------------------------------------------------------

// omp 环境变量惯例：PI_CONFIG_DIR 或 PI_CODING_AGENT_DIR
const PI_CONFIG_DIR = process.env.PI_CONFIG_DIR || ".omp";
const OMP_AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), PI_CONFIG_DIR, "agent");
const MODES_DIR = path.join(OMP_AGENT_DIR, "modes");
const GLOBAL_SKILLS_DIR = path.join(OMP_AGENT_DIR, "skills");
const GLOBAL_EXTENSIONS_DIR = path.join(OMP_AGENT_DIR, "extensions");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getModeDir(mode: string): string {
  return path.join(MODES_DIR, mode);
}
function getModeAgentsFile(mode: string): string {
  return path.join(getModeDir(mode), "agents.md");
}
function getModeSkillsDir(mode: string): string {
  return path.join(getModeDir(mode), "skills");
}
function getModeExtensionsDir(mode: string): string {
  return path.join(getModeDir(mode), "extensions");
}

function loadFile(filePath: string): string {
  try { return fs.readFileSync(filePath, "utf-8").trim(); }
  catch { return ""; }
}

function listModes(): string[] {
  ensureDir(MODES_DIR);
  return fs.readdirSync(MODES_DIR).filter((f) =>
    fs.statSync(path.join(MODES_DIR, f)).isDirectory()
  );
}

function listSkillsInDir(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
}

function listExtensionsInDir(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".ts") || f.endsWith(".js"));
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let currentMode = "coding";
let allToolNames: string[] = [];
let builtInToolNames: string[] = []; // tools from omp core (read, bash, edit, etc.)

// ---------------------------------------------------------------------------
// Mode-aware functions (exported via EventBus)
// ---------------------------------------------------------------------------

function getCurrentMode(): string { return currentMode; }
function isActiveMode(modes: string[]): boolean { return modes.includes(currentMode); }

/**
 * Check if an extension should be active based on its file path.
 * Hierarchy: global (always) → all (base) → current mode only
 */
function isActiveForMode(extensionPath: string): boolean {
  if (!extensionPath.includes("modes/")) return true;      // global
  if (extensionPath.includes("modes/all/")) return true;   // base layer
  if (extensionPath.includes(`modes/${currentMode}/`)) return true; // current
  return false;                                             // other mode
}

/** Default tools per mode (empty = all tools) */
const MODE_TOOLS: Record<string, string[]> = {
  all: [],
  coding: ["read", "write", "edit", "bash", "grep", "find", "ls"],
  research: ["read", "grep", "find", "ls"],
};

/** Compute allowed tools for current mode */
function computeAllowedTools(): string[] {
  const baseTools = MODE_TOOLS[currentMode];
  if (!baseTools || baseTools.length === 0) return []; // empty = all
  return baseTools;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function ompModeExtension(pi: ExtensionAPI) {

  // ── Startup ──────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    try {
      allToolNames = ctx.getAllTools().map((t) => t.name);
    } catch {
      try {
        allToolNames = ctx.getActiveTools();
      } catch {
        allToolNames = ["read", "write", "edit", "bash", "grep", "find", "ls"];
      }
    }
    builtInToolNames = ["read", "write", "edit", "bash", "grep", "find", "ls"];

    // Apply initial tool filter
    const allowed = computeAllowedTools();
    if (allowed.length > 0) {
      try { ctx.setActiveTools(allowed); } catch {}
    }

    // Publish mode state for other extensions
    pi.events.emit("mode_ready", { getCurrentMode, isActiveMode, isActiveForMode });
  });

  // ── System Prompt Processing ─────────────────────────────

  pi.on("before_agent_start", async (event) => {
    const agentsContent = loadFile(getModeAgentsFile(currentMode));
    if (!agentsContent) return {};

    let prompt = event.systemPrompt;

    // Step 1: Remove extension_context from inactive modes
    prompt = prompt.replace(
      /<extension_context mode="([^"]*)">([\s\S]*?)<\/extension_context>/g,
      (match, modesStr, content) => {
        const modes = modesStr.split(",").map((m: string) => m.trim());
        // Keep if: all, no mode specified, or includes current mode
        if (modes.includes("all") || modes.includes(currentMode)) return match;
        return ""; // Remove
      }
    );

    // Step 2: Split at "Available tools:" to replace role description
    const toolsMarker = "Available tools:";
    const toolsIndex = prompt.indexOf(toolsMarker);

    if (toolsIndex === -1) {
      return {
        systemPrompt: prompt + `\n\n<mode_rules priority="override">\n${agentsContent}\n</mode_rules>`,
      };
    }

    const beforeTools = prompt.substring(0, toolsIndex);
    const afterTools = prompt.substring(toolsIndex);

    // Step 3: Identify original role description vs injected content
    const rolePatterns = [
      /You are an expert coding assistant[\s\S]*?(?=\n\n|\n# )/,
      /You are a[\s\S]*?operating inside omp[\s\S]*?(?=\n\n|\n# )/,
    ];

    let injectedByOthers = beforeTools;
    for (const pattern of rolePatterns) {
      const match = beforeTools.match(pattern);
      if (match) {
        injectedByOthers = beforeTools.substring(match.index! + match[0].length).trim();
        break;
      }
    }

    // Step 4: Filter skills — global + all (base) + current mode
    const skills = event.systemPromptOptions.skills ?? [];
    const filteredSkills = skills.filter((skill) => {
      if (!skill.baseDir.includes("modes/")) return true;          // global
      if (skill.baseDir.includes("modes/all/")) return true;       // base
      if (currentMode !== "all" && skill.baseDir.includes(`modes/${currentMode}/`)) return true;
      return false;
    });

    let skillsSection = "";
    if (filteredSkills.length > 0) {
      skillsSection = "\n\n<available_skills>\n";
      for (const skill of filteredSkills) {
        skillsSection += `<skill name="${skill.name}" description="${skill.description}" path="${skill.filePath}" />\n`;
      }
      skillsSection += "</available_skills>";
    }

    // Step 5: Extract date and cwd
    const dateMatch = prompt.match(/Current date: .+/);
    const cwdMatch = prompt.match(/Current working directory: .+/);
    const meta = [dateMatch?.[0], cwdMatch?.[0]].filter(Boolean).join("\n");

    // Step 6: Assemble final prompt
    let newPrompt = agentsContent;
    if (injectedByOthers) newPrompt += "\n\n" + injectedByOthers;
    newPrompt += "\n\n" + afterTools;
    if (skillsSection) {
      if (newPrompt.includes("<available_skills>")) {
        newPrompt = newPrompt.replace(/<available_skills>[\s\S]*?<\/available_skills>/, skillsSection);
      } else {
        newPrompt += skillsSection;
      }
    }
    if (meta) newPrompt += "\n\n" + meta;

    return { systemPrompt: newPrompt };
  });

  // ── /mode Command ────────────────────────────────────────

  pi.registerCommand("mode", {
    description: "Switch, list, or create agent modes",
    argumentHint: "[mode-name | list | create <name>]",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const action = parts[0]?.toLowerCase();

      if (!action) {
        const modes = listModes();
        const lines = [`Current mode: ${ctx.ui.theme.bold(currentMode)}`, ""];
        for (const mode of modes) {
          const marker = mode === currentMode ? " ◀" : "";
          const hasFile = fs.existsSync(getModeAgentsFile(mode));
          const status = hasFile ? "" : ctx.ui.theme.fg("warning", " (no agents.md)");
          lines.push(`  ${ctx.ui.theme.fg("accent", mode)}${status}${marker}`);
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (action === "list") {
        const modes = listModes();
        const lines = ["Available modes:", ""];
        for (const mode of modes) {
          const marker = mode === currentMode ? " ◀" : "";
          const skillsCount = listSkillsInDir(getModeSkillsDir(mode)).length;
          const extsCount = listExtensionsInDir(getModeExtensionsDir(mode)).length;
          lines.push(`  ${ctx.ui.theme.fg("accent", mode)} — ${skillsCount} skills, ${extsCount} extensions${marker}`);
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (action === "create") {
        const name = parts[1]?.toLowerCase();
        if (!name) { ctx.ui.notify("Usage: /mode create <name>", "error"); return; }
        if (listModes().includes(name)) { ctx.ui.notify(`Mode "${name}" already exists`, "error"); return; }

        const modeDir = getModeDir(name);
        ensureDir(modeDir);
        ensureDir(getModeSkillsDir(name));
        ensureDir(getModeExtensionsDir(name));
        fs.writeFileSync(getModeAgentsFile(name),
          `# ${name} Mode\n\nYou are a helpful assistant operating inside omp.\n\n# Guidelines\n\n- Be concise\n- Follow user instructions\n`,
          "utf-8"
        );
        ctx.ui.notify(`Created mode "${name}" at ${modeDir}`, "success");
        ctx.ui.notify(`Edit ${getModeAgentsFile(name)} to customize`, "info");
        return;
      }

      // Switch mode
      const target = action;
      if (!listModes().includes(target)) {
        ctx.ui.notify(`Unknown mode: "${target}". Use /mode list to see available modes.`, "error");
        return;
      }

      currentMode = target;

      // Filter tools for new mode
      const allowed = computeAllowedTools();
      if (allowed.length > 0) {
        try { ctx.setActiveTools(allowed); } catch {}
      }

      // Emit mode_changed event for other extensions
      pi.events.emit("mode_changed", { mode: currentMode, getCurrentMode, isActiveMode, isActiveForMode });

      const skillsCount = listSkillsInDir(getModeSkillsDir(target)).length;
      const extsCount = listExtensionsInDir(getModeExtensionsDir(target)).length;
      ctx.ui.notify(`Switched to mode: ${ctx.ui.theme.fg("accent", target)} (${skillsCount} skills, ${extsCount} extensions)`, "success");

      // Reload to apply new system prompt
      ctx.reload();
    },
  });

  // ── Tools ────────────────────────────────────────────────

  const z = pi.zod;

  pi.registerTool({
    name: "mode_list",
    label: "List Modes",
    description: "List all available agent modes.",
    parameters: z.object({}),
    async execute() {
      const modes = listModes();
      const lines = modes.map(m => {
        const marker = m === currentMode ? " (current)" : "";
        const skillsCount = listSkillsInDir(getModeSkillsDir(m)).length;
        const extsCount = listExtensionsInDir(getModeExtensionsDir(m)).length;
        return `- ${m}${marker} — ${skillsCount} skills, ${extsCount} extensions`;
      });
      return { content: [{ type: "text", text: `Available modes:\n${lines.join("\n")}` }] };
    },
  });

  pi.registerTool({
    name: "mode_switch",
    label: "Switch Mode",
    description: "Switch to a different agent mode.",
    parameters: z.object({
      mode: z.string().describe("Mode name to switch to."),
    }),
    async execute(_id, params) {
      if (!listModes().includes(params.mode)) {
        return { content: [{ type: "text", text: `Unknown mode: "${params.mode}". Use mode_list to see available modes.` }] };
      }
      currentMode = params.mode;
      const allowed = computeAllowedTools();
      if (allowed.length > 0) {
        try { /* ctx.setActiveTools(allowed); */ } catch {}
      }
      pi.events.emit("mode_changed", { mode: currentMode, getCurrentMode, isActiveMode, isActiveForMode });
      return { content: [{ type: "text", text: `Switched to mode: ${params.mode}` }] };
    },
  });

  pi.registerTool({
    name: "mode_create",
    label: "Create Mode",
    description: "Create a new agent mode.",
    parameters: z.object({
      name: z.string().describe("Mode name (lowercase, e.g. 'research', 'writing')."),
      description: z.string().optional().describe("Mode description."),
    }),
    async execute(_id, params) {
      const name = params.name.toLowerCase();
      if (listModes().includes(name)) {
        return { content: [{ type: "text", text: `Mode "${name}" already exists.` }] };
      }

      const modeDir = getModeDir(name);
      ensureDir(modeDir);
      ensureDir(getModeSkillsDir(name));
      ensureDir(getModeExtensionsDir(name));

      const description = params.description || `You are a helpful assistant in ${name} mode.`;
      fs.writeFileSync(getModeAgentsFile(name),
        `# ${name} Mode\n\n${description}\n\n# Guidelines\n\n- Be concise\n- Follow user instructions\n`,
        "utf-8"
      );

      return { content: [{ type: "text", text: `Created mode "${name}" at ${modeDir}\nEdit ${getModeAgentsFile(name)} to customize.` }] };
    },
  });

  // ── Exports for other extensions ──────────────────────────

  // Export mode functions via EventBus for other extensions
  pi.events.emit("mode_exports", {
    getCurrentMode,
    isActiveMode,
    isActiveForMode,
  });
}
