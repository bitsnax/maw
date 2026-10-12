// Writes OpenCode's config from the environment (maw-opencode's compose
// service). Settings follow the developer's .202 OpenCode (10-12-2026):
// llama.cpp provider "llamacpp", 65,536 context / 16,384 output, compaction,
// the DCP plugin (pinned). Commands and edits run without asking (the tools
// still ask OpenCode, so "ask" here would turn approvals on).
import { writeFileSync } from "node:fs"

const env = (k, d) => (process.env[k] ?? "").trim() || d
const model = env("LLAMACPP_MODEL", "Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp")
const context = Number(env("LLAMACPP_CONTEXT", "65536"))
const output = Number(env("LLAMACPP_OUTPUT", "16384"))
const dcp = env("MAW_OPENCODE_DCP", "@tarquinen/opencode-dcp@3.2.0")

const config = {
  $schema: "https://opencode.ai/config.json",
  model: `llamacpp/${model}`,
  small_model: `llamacpp/${model}`,
  autoupdate: false,
  share: "disabled",
  snapshot: false,
  lsp: false,
  formatter: false,
  permission: { bash: env("MAW_OPENCODE_BASH", "allow"), edit: env("MAW_OPENCODE_EDIT", "allow") },
  tools: { apply_patch: false, websearch: false },
  compaction: { auto: true, keep: { tokens: 24000 }, buffer: 10000 },
  plugin: dcp === "none" ? [] : [dcp],
  provider: {
    llamacpp: {
      npm: "@ai-sdk/openai-compatible",
      name: "llama.cpp (GPU box)",
      options: { baseURL: env("LLAMACPP_BASE_URL", "http://192.168.4.201:8081/v1"), apiKey: "{env:LLAMACPP_API_KEY}" },
      models: { [model]: { name: model, limit: { context, output } } },
    },
  },
}
const file = `${process.env.XDG_CONFIG_HOME}/opencode/opencode.json`
writeFileSync(file, JSON.stringify(config, null, 2) + "\n")
console.log(`maw-opencode: wrote ${file}`)
