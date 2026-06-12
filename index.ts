/**
 * omp-agent: Multi-Agent Management Extension for Oh My Pi
 *
 * Features:
 * - /agent command to switch, list, create, edit, delete agents
 * - Per-agent config: model, thinking level, tools, goals, constraints
 * - Per-agent system prompt (system.md)
 * - agent_list / agent_switch / agent_create tools for LLM
 * - agent_changed event for cross-extension communication
 * - Compatible with old modes/ directory (auto-migration)
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PI_CONFIG_DIR = process.env.PI_CONFIG_DIR || ".omp";
const OMP_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), PI_CONFIG_DIR, "agent");
const AGENTS_DIR = path.join(OMP_DIR, "agents");
const LEGACY_MODES_DIR = path.join(OMP_DIR, "modes");
const CURRENT_FILE = path.join(AGENTS_DIR, ".current");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentConfig {
  name: string;
  description?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  skills?: string[];       // ["global", "@yuechou/omp-memory"] — filter which skills are visible
  extensions?: string[];   // ["global", "@yuechou/omp-memory"] — filter which extensions are loaded
  goals?: string[];
  constraints?: string[];
}

// ---------------------------------------------------------------------------
// YAML Parser (minimal — handles our flat agent.yml format)
// ---------------------------------------------------------------------------

function parseYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    // Skip comments and blank lines
    if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue;

    // List item
    if (/^\s*-\s+/.test(line)) {
      const value = line.replace(/^\s*-\s+/, "").trim().replace(/^["']|["']$/g, "");
      if (currentKey && currentList) {
        currentList.push(value);
      }
      continue;
    }

    // Flush previous list
    if (currentKey && currentList) {
      result[currentKey] = currentList;
      currentKey = null;
      currentList = null;
    }

    // Key: value pair
    const match = line.match(/^(\w[\w-]*):\s*(.*)/);
    if (match) {
      const [, key, rawValue] = match;
      const value = rawValue.trim();

      // Start of a list
      if (value === "" || value === "[]") {
        if (value === "[]") {
          result[key] = [];
        } else {
          currentKey = key;
          currentList = [];
        }
        continue;
      }

      // Scalar value
      result[key] = value.replace(/^["']|["']$/g, "");
    }
  }

  // Flush last list
  if (currentKey && currentList) {
    result[currentKey] = currentList;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadFile(filePath: string): string {
  try { return fs.readFileSync(filePath, "utf-8").trim(); }
  catch { return ""; }
}

function getAgentDir(name: string): string {
  return path.join(AGENTS_DIR, name);
}

function getAgentConfigPath(name: string): string {
  return path.join(getAgentDir(name), "agent.yml");
}

function getAgentSystemPromptPath(name: string): string {
  return path.join(getAgentDir(name), "system.md");
}

function getAgentSkillsDir(name: string): string {
  return path.join(getAgentDir(name), "skills");
}

function getAgentExtensionsDir(name: string): string {
  return path.join(getAgentDir(name), "extensions");
}

// ---------------------------------------------------------------------------
// Agent CRUD
// ---------------------------------------------------------------------------

function loadAgentConfig(name: string): AgentConfig | null {
  const configPath = getAgentConfigPath(name);
  if (!fs.existsSync(configPath)) return null;

  const raw = parseYaml(loadFile(configPath));
  return {
    name: (raw.name as string) || name,
    description: raw.description as string | undefined,
    model: raw.model as string | undefined,
    thinking: raw.thinking as string | undefined,
    tools: raw.tools as string[] | undefined,
    skills: raw.skills as string[] | undefined,
    extensions: raw.extensions as string[] | undefined,
    goals: raw.goals as string[] | undefined,
    constraints: raw.constraints as string[] | undefined,
  };
}

function saveAgentConfig(config: AgentConfig): void {
  const dir = getAgentDir(config.name);
  ensureDir(dir);

  const lines: string[] = [`name: ${config.name}`];
  if (config.description) lines.push(`description: "${config.description}"`);
  if (config.model) lines.push(`model: ${config.model}`);
  if (config.thinking) lines.push(`thinking: ${config.thinking}`);
  if (config.tools && config.tools.length > 0) {
    lines.push("tools:");
    for (const t of config.tools) lines.push(`  - ${t}`);
  }
  if (config.skills && config.skills.length > 0) {
    lines.push("skills:");
    for (const s of config.skills) lines.push(`  - ${s}`);
  }
  if (config.extensions && config.extensions.length > 0) {
    lines.push("extensions:");
    for (const e of config.extensions) lines.push(`  - ${e}`);
  }
  if (config.goals && config.goals.length > 0) {
    lines.push("goals:");
    for (const g of config.goals) lines.push(`  - "${g}"`);
  }
  if (config.constraints && config.constraints.length > 0) {
    lines.push("constraints:");
    for (const c of config.constraints) lines.push(`  - "${c}"`);
  }

  fs.writeFileSync(getAgentConfigPath(config.name), lines.join("\n") + "\n", "utf-8");
}

function listAgents(): string[] {
  ensureDir(AGENTS_DIR);
  return fs.readdirSync(AGENTS_DIR).filter((f) => {
    const full = path.join(AGENTS_DIR, f);
    return fs.statSync(full).isDirectory() && !f.startsWith(".");
  });
}

function listPlugins(): string[] {
  const pluginsDir = path.join(OMP_DIR, "plugins", "node_modules");
  if (!fs.existsSync(pluginsDir)) return [];
  const scopes = fs.readdirSync(pluginsDir);
  const plugins: string[] = [];
  for (const scope of scopes) {
    if (scope.startsWith("@")) {
      const scopeDir = path.join(pluginsDir, scope);
      for (const pkg of fs.readdirSync(scopeDir)) {
        plugins.push(`${scope}/${pkg}`);
      }
    } else {
      plugins.push(scope);
    }
  }
  return plugins;
}

function deleteAgent(name: string): boolean {
  const dir = getAgentDir(name);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

function getCurrentAgent(): string {
  return loadFile(CURRENT_FILE) || "coding";
}

function setCurrentAgent(name: string): void {
  fs.writeFileSync(CURRENT_FILE, name, "utf-8");
}

// ---------------------------------------------------------------------------
// Agent system prompt assembly
// ---------------------------------------------------------------------------

function buildAgentSystemPrompt(config: AgentConfig): string {
  const systemMd = loadFile(getAgentSystemPromptPath(config.name));
  const parts: string[] = [];

  // System prompt from system.md
  if (systemMd) {
    parts.push(systemMd);
  }

  // Goals
  if (config.goals && config.goals.length > 0) {
    parts.push("# Goals\n\n" + config.goals.map(g => `- ${g}`).join("\n"));
  }

  // Constraints
  if (config.constraints && config.constraints.length > 0) {
    parts.push("# Constraints\n\n" + config.constraints.map(c => `- ${c}`).join("\n"));
  }

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Migrate old modes/ → agents/
// ---------------------------------------------------------------------------

function migrateLegacyModes(): void {
  if (fs.existsSync(AGENTS_DIR) && listAgents().length > 0) return;
  if (!fs.existsSync(LEGACY_MODES_DIR)) return;

  ensureDir(AGENTS_DIR);
  const modes = fs.readdirSync(LEGACY_MODES_DIR).filter((f) =>
    fs.statSync(path.join(LEGACY_MODES_DIR, f)).isDirectory()
  );

  for (const mode of modes) {
    if (mode === "all") continue; // skip "all" base layer
    const srcDir = path.join(LEGACY_MODES_DIR, mode);
    const dstDir = path.join(AGENTS_DIR, mode);

    if (fs.existsSync(dstDir)) continue;
    fs.cpSync(srcDir, dstDir, { recursive: true });

    // Create agent.yml if missing
    if (!fs.existsSync(getAgentConfigPath(mode))) {
      saveAgentConfig({
        name: mode,
        description: `Migrated from legacy mode: ${mode}`,
      });
    }

    // Rename agents.md → system.md if needed
    const agentsMd = path.join(dstDir, "agents.md");
    const systemMd = path.join(dstDir, "system.md");
    if (fs.existsSync(agentsMd) && !fs.existsSync(systemMd)) {
      fs.renameSync(agentsMd, systemMd);
    }
  }
}

// ---------------------------------------------------------------------------
// Default agents
// ---------------------------------------------------------------------------

function ensureDefaultAgents(): void {
  ensureDir(AGENTS_DIR);

  if (!fs.existsSync(getAgentDir("coding"))) {
    saveAgentConfig({
      name: "coding",
      description: "代码编写与调试",
      thinking: "high",
      tools: ["read", "write", "edit", "bash", "grep", "find", "ls", "lsp", "search", "task"],
      skills: ["global"],
      extensions: ["global"],
      goals: [
        "编写高质量、可维护的代码",
        "遵循项目现有风格和架构",
        "在修改前充分理解上下文",
      ],
      constraints: [
        "不要引入不必要的依赖",
        "保持向后兼容",
      ],
    });
    fs.writeFileSync(getAgentSystemPromptPath("coding"),
      "# Coding Agent\n\nYou are an expert coding assistant. You write clean, maintainable code and follow project conventions.\n",
      "utf-8"
    );
  }

  if (!fs.existsSync(getAgentDir("research"))) {
    saveAgentConfig({
      name: "research",
      description: "代码研究与分析（只读）",
      thinking: "medium",
      tools: ["read", "grep", "find", "ls", "search", "lsp"],
      skills: ["global"],
      extensions: ["global"],
      goals: [
        "深入理解代码结构和设计模式",
        "提供准确、有依据的分析",
      ],
      constraints: [
        "不要修改任何文件",
        "只进行读取操作",
      ],
    });
    fs.writeFileSync(getAgentSystemPromptPath("research"),
      "# Research Agent\n\nYou are a code research assistant. You analyze codebases, explain architecture, and answer questions without making changes.\n",
      "utf-8"
    );
  }

  if (!listAgents().includes(getCurrentAgent())) {
    setCurrentAgent("coding");
  }
}

// ---------------------------------------------------------------------------
// Resolve thinking level
// ---------------------------------------------------------------------------

function resolveThinkingLevel(level: string | undefined): number | undefined {
  if (!level) return undefined;
  const map: Record<string, number> = {
    off: 0,
    minimal: 1,
    low: 2,
    medium: 3,
    high: 4,
    xhigh: 5,
  };
  return map[level.toLowerCase()];
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function ompAgentExtension(pi: ExtensionAPI) {
  const z = pi.zod;
  let currentAgent = getCurrentAgent();

  // ── Startup ──────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    // Migrate legacy modes if needed
    try { migrateLegacyModes(); } catch {}

    // Ensure default agents exist
    try { ensureDefaultAgents(); } catch {}

    // Load current agent config
    const config = loadAgentConfig(currentAgent);
    if (!config) {
      currentAgent = "coding";
      setCurrentAgent("coding");
    }

    // Apply agent config
    const cfg = loadAgentConfig(currentAgent);
    if (cfg) {
      // Set thinking level
      const level = resolveThinkingLevel(cfg.thinking);
      if (level !== undefined) {
        try { pi.setThinkingLevel(level); } catch {}
      }

      // Set tools
      if (cfg.tools && cfg.tools.length > 0) {
        try { ctx.setActiveTools(cfg.tools); } catch {}
      }
    }

    // Publish agent state for other extensions
    pi.events.emit("agent_ready", {
      getCurrentAgent: () => currentAgent,
      getAgentConfig: loadAgentConfig,
    });
  });

  // ── Skills Isolation ───────────────────────────────────

  pi.on("resources_discover", () => {
    const config = loadAgentConfig(currentAgent);
    const skillPaths: string[] = [];

    // If no skills filter → include everything
    if (!config?.skills || config.skills.length === 0) {
      skillPaths.push(
        path.join(OMP_DIR, "skills"),
        getAgentSkillsDir(currentAgent),
      );
    } else {
      for (const entry of config.skills) {
        if (entry === "global") {
          skillPaths.push(path.join(OMP_DIR, "skills"));
        } else {
          // Plugin name → look for skills in plugin directory
          const pluginSkillsDir = path.join(OMP_DIR, "plugins", "node_modules", entry, "skills");
          if (fs.existsSync(pluginSkillsDir)) {
            skillPaths.push(pluginSkillsDir);
          }
        }
      }
      // Always include agent's own skills
      skillPaths.push(getAgentSkillsDir(currentAgent));
    }

    return { skillPaths };
  });

  // ── System Prompt Injection ─────────────────────────────

  pi.on("before_agent_start", async (event) => {
    const config = loadAgentConfig(currentAgent);
    if (!config) return {};

    const agentPrompt = buildAgentSystemPrompt(config);
    if (!agentPrompt) return {};

    // Prepend agent prompt to system prompt
    const prompts = [...event.systemPrompt];
    prompts.unshift(agentPrompt);

    return { systemPrompt: prompts };
  });

  // ── Switch Agent Logic ──────────────────────────────────

  async function switchAgent(
    name: string,
    ctx: ExtensionCommandContext,
    clearHistory?: boolean,
  ): Promise<boolean> {
    const config = loadAgentConfig(name);
    if (!config) {
      ctx.ui.notify(`Agent "${name}" not found. Use /agent list to see available agents.`, "error");
      return false;
    }

    const prevAgent = currentAgent;
    currentAgent = name;
    setCurrentAgent(name);

    // Apply model
    if (config.model) {
      try {
        const modelRegistry = ctx.modelRegistry;
        // Try to find model by pattern
        const models = modelRegistry.getAvailableModels?.() ?? [];
        const match = models.find((m: { id: string }) =>
          m.id === config.model || m.id.endsWith("/" + config.model)
        );
        if (match) {
          await pi.setModel(match);
        } else {
          ctx.ui.notify(`Model "${config.model}" not found, keeping current model.`, "warning");
        }
      } catch {
        ctx.ui.notify(`Failed to switch model to "${config.model}".`, "warning");
      }
    }

    // Apply thinking level
    const level = resolveThinkingLevel(config.thinking);
    if (level !== undefined) {
      try { pi.setThinkingLevel(level); } catch {}
    }

    // Apply tools
    if (config.tools && config.tools.length > 0) {
      try { await ctx.setActiveTools(config.tools); } catch {}
    }

    // Reload extensions for agent isolation
    try {
      const extensionPaths: string[] = [];

      if (!config.extensions || config.extensions.length === 0) {
        // No filter → include everything
        extensionPaths.push(
          path.join(OMP_DIR, "extensions"),
          getAgentExtensionsDir(name),
        );
      } else {
        for (const entry of config.extensions) {
          if (entry === "global") {
            extensionPaths.push(path.join(OMP_DIR, "extensions"));
          } else {
            // Plugin name → look for extension entry in plugin
            const pluginDir = path.join(OMP_DIR, "plugins", "node_modules", entry);
            if (fs.existsSync(pluginDir)) {
              const pluginPkg = path.join(pluginDir, "package.json");
              try {
                const pkg = JSON.parse(fs.readFileSync(pluginPkg, "utf-8"));
                const ext = pkg.omp?.extensions?.[0] || pkg.main || "index.ts";
                extensionPaths.push(path.join(pluginDir, ext));
              } catch {}
            }
          }
        }
        // Always include agent's own extensions
        extensionPaths.push(getAgentExtensionsDir(name));
      }

      await pi.reloadExtensions(extensionPaths);
    } catch {}

    // Emit event
    pi.events.emit("agent_changed", {
      agent: name,
      previousAgent: prevAgent,
      config,
    });

    // Show summary
    const modelStr = config.model || "current";
    const thinkingStr = config.thinking || "current";
    const toolsStr = config.tools ? `${config.tools.length} tools` : "all tools";
    ctx.ui.notify(
      `Switched to agent: ${ctx.ui.theme.fg("accent", name)} ` +
      `(${modelStr}, ${thinkingStr}, ${toolsStr})`,
      "success"
    );

    // Handle history
    if (clearHistory) {
      ctx.ui.notify("Starting new session with fresh history...", "info");
      await ctx.newSession();
    } else {
      await ctx.reload();
    }

    return true;
  }

  // ── /agent-list Command ─────────────────────────────────

  pi.registerCommand("agent-list", {
    description: "List all agents with their configurations",
    handler: async (_args, ctx) => {
      const agents = listAgents();
      const lines = ["Available agents:", ""];
      for (const name of agents) {
        const cfg = loadAgentConfig(name);
        const marker = name === currentAgent ? " ◀" : "";
        const desc = cfg?.description || "";
        const model = cfg?.model || "inherit";
        const thinking = cfg?.thinking || "inherit";
        const tools = cfg?.tools ? cfg.tools.length + " tools" : "all";
        lines.push(`  ${ctx.ui.theme.fg("accent", name)}${marker}`);
        lines.push(`    ${desc}`);
        lines.push(`    model: ${model} | thinking: ${thinking} | tools: ${tools}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── /agent Command (switch via selector) ───────────────

  pi.registerCommand("agent", {
    description: "Switch to a different agent",
    handler: async (_args, ctx) => {
      const agents = listAgents();
      if (agents.length === 0) {
        ctx.ui.notify("No agents found. Use /agent-create to create one.", "error");
        return;
      }

      // Build selector options with config summary
      const options = agents.map(name => {
        const cfg = loadAgentConfig(name);
        const desc = cfg?.description || "";
        const model = cfg?.model || "inherit";
        const thinking = cfg?.thinking || "inherit";
        const marker = name === currentAgent ? " (current)" : "";
        return {
          label: `${name}${marker}`,
          description: `${desc} | model: ${model} | thinking: ${thinking}`,
        };
      });

      const selected = await ctx.ui.select("Select agent:", options);
      if (!selected) return;

      // Extract agent name (strip " (current)" suffix)
      const target = selected.replace(/ \(current\)$/, "");
      if (target === currentAgent) {
        ctx.ui.notify(`Already on agent "${target}".`, "info");
        return;
      }

      // Ask about history
      const clearHistory = await ctx.ui.confirm("Switch agent", "Clear conversation history?");
      await switchAgent(target, ctx, clearHistory ?? false);
    },
  });

  // ── /agent-create Command ─────────────────────────────

  pi.registerCommand("agent-create", {
    description: "Create a new agent interactively",
    handler: async (_args, ctx) => {
      // Step 1: Name
      const name = await ctx.ui.input("Agent name:", "my-agent");
      if (!name) return;
      const normalizedName = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      if (listAgents().includes(normalizedName)) {
        ctx.ui.notify(`Agent "${normalizedName}" already exists.`, "error");
        return;
      }

      // Step 2: Description
      const description = await ctx.ui.input("Description:", "A helpful assistant");

      // Step 3: Model
      const modelOptions = [
        { label: "(inherit)", description: "Use the current session model" },
        { label: "anthropic/claude-sonnet-4-6", description: "Claude Sonnet 4.6" },
        { label: "anthropic/claude-opus-4-8", description: "Claude Opus 4.8" },
        { label: "anthropic/claude-haiku-4-5", description: "Claude Haiku 4.5" },
      ];
      const model = await ctx.ui.select("Model:", modelOptions);
      if (model === undefined) return;

      // Step 4: Thinking level
      const thinkingOptions = [
        { label: "(inherit)", description: "Use the current thinking level" },
        { label: "minimal", description: "~1k tokens" },
        { label: "low", description: "~2k tokens" },
        { label: "medium", description: "~8k tokens" },
        { label: "high", description: "~16k tokens" },
        { label: "xhigh", description: "~32k tokens" },
      ];
      const thinking = await ctx.ui.select("Thinking level:", thinkingOptions);
      if (thinking === undefined) return;

      // Step 5: Tools
      const toolPresets = [
        { label: "all", description: "All available tools" },
        { label: "coding", description: "read, write, edit, bash, grep, find, ls, lsp, search, task" },
        { label: "research", description: "read, grep, find, ls, search, lsp (read-only)" },
        { label: "custom...", description: "Enter tool names manually" },
      ];
      const toolChoice = await ctx.ui.select("Tools:", toolPresets);
      if (toolChoice === undefined) return;

      let tools: string[] | undefined;
      if (toolChoice === "all") {
        tools = undefined;
      } else if (toolChoice === "coding") {
        tools = ["read", "write", "edit", "bash", "grep", "find", "ls", "lsp", "search", "task"];
      } else if (toolChoice === "research") {
        tools = ["read", "grep", "find", "ls", "search", "lsp"];
      } else {
        const customTools = await ctx.ui.input("Tools (comma-separated):", "read, write, edit, bash");
        if (customTools) {
          tools = customTools.split(",").map(t => t.trim()).filter(Boolean);
        }
      }

      // Step 6: Skills & Extensions
      const plugins = listPlugins();
      const skillOptions = [
        { label: "global", description: "All global skills" },
        ...plugins.map(p => ({ label: p, description: `Skills from ${p}` })),
      ];
      const selectedSkills = await ctx.ui.select("Skills (global = all):", skillOptions);
      const skills = selectedSkills ? [selectedSkills] : ["global"];

      const extOptions = [
        { label: "global", description: "All global extensions" },
        ...plugins.map(p => ({ label: p, description: `Extension from ${p}` })),
      ];
      const selectedExts = await ctx.ui.select("Extensions (global = all):", extOptions);
      const extensions = selectedExts ? [selectedExts] : ["global"];

      // Create agent
      const config: AgentConfig = {
        name: normalizedName,
        description: description || undefined,
        model: model === "(inherit)" ? undefined : model,
        thinking: thinking === "(inherit)" ? undefined : thinking,
        tools,
        skills,
        extensions,
        goals: [],
        constraints: [],
      };

      saveAgentConfig(config);
      fs.writeFileSync(getAgentSystemPromptPath(normalizedName),
        `# ${normalizedName} Agent\n\nYou are a helpful assistant.\n`,
        "utf-8"
      );

      ctx.ui.notify(`Created agent "${normalizedName}"`, "success");

      // Ask to switch
      const doSwitch = await ctx.ui.confirm("Switch now?", `Switch to the new agent "${normalizedName}"?`);
      if (doSwitch) {
        await switchAgent(normalizedName, ctx, false);
      }
    },
  });

  // ── /agent-edit Command ───────────────────────────────

  pi.registerCommand("agent-edit", {
    description: "Edit an agent's configuration or system prompt",
    handler: async (_args, ctx) => {
      const agents = listAgents();
      if (agents.length === 0) {
        ctx.ui.notify("No agents found.", "error");
        return;
      }

      // Select agent to edit
      const options = agents.map(name => {
        const cfg = loadAgentConfig(name);
        const marker = name === currentAgent ? " (current)" : "";
        return {
          label: `${name}${marker}`,
          description: cfg?.description || "",
        };
      });

      const selected = await ctx.ui.select("Select agent to edit:", options);
      if (!selected) return;
      const target = selected.replace(/ \(current\)$/, "");

      // Choose what to edit
      const action = await ctx.ui.select("What to edit:", [
        { label: "Config (agent.yml)", description: "Model, thinking, tools, goals, constraints" },
        { label: "System prompt (system.md)", description: "The agent's system prompt" },
      ]);
      if (!action) return;

      if (action.startsWith("Config")) {
        const configPath = getAgentConfigPath(target);
        ctx.ui.notify(`Edit: ${configPath}`, "info");
        // Open in editor
        const content = loadFile(configPath);
        const edited = await ctx.ui.editor(`agent.yml — ${target}`, content);
        if (edited !== undefined) {
          fs.writeFileSync(configPath, edited, "utf-8");
          ctx.ui.notify("Config saved. Changes apply on next turn.", "success");
        }
      } else {
        const promptPath = getAgentSystemPromptPath(target);
        ctx.ui.notify(`Edit: ${promptPath}`, "info");
        const content = loadFile(promptPath);
        const edited = await ctx.ui.editor(`system.md — ${target}`, content);
        if (edited !== undefined) {
          fs.writeFileSync(promptPath, edited, "utf-8");
          ctx.ui.notify("System prompt saved. Changes apply on next turn.", "success");
        }
      }
    },
  });

  // ── Tools (for LLM) ─────────────────────────────────────

  pi.registerTool({
    name: "agent_list",
    label: "List Agents",
    description: "List all available agents with their configurations.",
    parameters: z.object({}),
    approval: "read" as const,
    async execute() {
      const agents = listAgents();
      const lines = agents.map(name => {
        const cfg = loadAgentConfig(name);
        const marker = name === currentAgent ? " (current)" : "";
        const desc = cfg?.description || "";
        const model = cfg?.model || "inherit";
        const thinking = cfg?.thinking || "inherit";
        const tools = cfg?.tools ? cfg.tools.join(", ") : "all";
        const skills = cfg?.skills ? cfg.skills.join(", ") : "all";
        const extensions = cfg?.extensions ? cfg.extensions.join(", ") : "all";
        return `- ${name}${marker}: ${desc}\n  model: ${model} | thinking: ${thinking} | tools: ${tools}\n  skills: ${skills} | extensions: ${extensions}`;
      });
      return { content: [{ type: "text", text: `Available agents:\n${lines.join("\n")}` }] };
    },
  });

  pi.registerTool({
    name: "agent_switch",
    label: "Switch Agent",
    description: "Switch to a different agent. Changes model, thinking level, tools, and system prompt.",
    parameters: z.object({
      agent: z.string().describe("Agent name to switch to."),
      clear_history: z.boolean().optional().describe("If true, start a fresh session without conversation history."),
    }),
    approval: "write" as const,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!listAgents().includes(params.agent)) {
        return { content: [{ type: "text", text: `Agent "${params.agent}" not found. Use agent_list to see available agents.` }] };
      }
      if (params.agent === currentAgent) {
        return { content: [{ type: "text", text: `Already on agent "${params.agent}".` }] };
      }

      // Note: tools can't call ctx.newSession(), so clear_history is ignored when called from LLM
      const config = loadAgentConfig(params.agent)!;
      const prev = currentAgent;
      currentAgent = params.agent;
      setCurrentAgent(params.agent);

      // Apply config
      if (config.thinking) {
        const level = resolveThinkingLevel(config.thinking);
        if (level !== undefined) {
          try { pi.setThinkingLevel(level); } catch {}
        }
      }
      if (config.tools && config.tools.length > 0) {
        try { await ctx.setActiveTools(config.tools); } catch {}
      }

      pi.events.emit("agent_changed", { agent: params.agent, previousAgent: prev, config });

      const modelStr = config.model || "current";
      const thinkingStr = config.thinking || "current";
      const toolsStr = config.tools ? `${config.tools.length} tools` : "all tools";
      return {
        content: [{
          type: "text",
          text: `Switched to agent "${params.agent}" (${modelStr}, ${thinkingStr}, ${toolsStr}). ` +
            `System prompt will update on the next turn.`,
        }],
      };
    },
  });

  pi.registerTool({
    name: "agent_create",
    label: "Create Agent",
    description: "Create a new agent with a custom configuration.",
    parameters: z.object({
      name: z.string().describe("Agent name (lowercase, e.g. 'writer', 'devops')."),
      description: z.string().optional().describe("Short description of the agent's purpose."),
      model: z.string().optional().describe("Model ID (e.g. 'anthropic/claude-sonnet-4-6'). Omit to inherit."),
      thinking: z.string().optional().describe("Thinking level: off, minimal, low, medium, high, xhigh. Omit to inherit."),
      tools: z.array(z.string()).optional().describe("List of allowed tool names. Omit for all tools."),
      system_prompt: z.string().optional().describe("System prompt content (written to system.md)."),
    }),
    approval: "write" as const,
    async execute(_id, params) {
      const name = params.name.toLowerCase();
      if (listAgents().includes(name)) {
        return { content: [{ type: "text", text: `Agent "${name}" already exists.` }] };
      }

      const config: AgentConfig = {
        name,
        description: params.description,
        model: params.model,
        thinking: params.thinking,
        tools: params.tools,
        goals: [],
        constraints: [],
      };

      saveAgentConfig(config);

      if (params.system_prompt) {
        fs.writeFileSync(getAgentSystemPromptPath(name), params.system_prompt, "utf-8");
      } else {
        fs.writeFileSync(getAgentSystemPromptPath(name),
          `# ${name} Agent\n\nYou are a helpful assistant.\n`,
          "utf-8"
        );
      }

      return {
        content: [{
          type: "text",
          text: `Created agent "${name}" at ${getAgentDir(name)}\n` +
            `Config: ${getAgentConfigPath(name)}\n` +
            `Prompt: ${getAgentSystemPromptPath(name)}`,
        }],
      };
    },
  });

  // ── Exports for other extensions ──────────────────────────

  pi.events.emit("agent_exports", {
    getCurrentAgent: () => currentAgent,
    getAgentConfig: loadAgentConfig,
    switchAgent: (name: string) => {
      const config = loadAgentConfig(name);
      if (config) {
        currentAgent = name;
        setCurrentAgent(name);
        pi.events.emit("agent_changed", { agent: name, config });
      }
    },
  });
}
