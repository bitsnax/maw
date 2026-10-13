// A stand-in for llama.cpp (OpenAI chat API, streaming) that drives
// maw-opencode's six tools in a fixed order, for phase3-03's self-test.
//   prompt containing "sleep": calls bash `sleep 30` (the test aborts it)
//   prompt containing "slow": answers after 4 s, streamed in a few pieces
//   prompt containing "ask": calls OpenCode's question tool (two options)
//   prompt containing "git status": runs `git status --short --branch`
//   prompt with lines "CALL <tool> <json args>": calls those tools in order,
//     then answers "calls done" (story tools and refused git in the tests)
//   any other prompt: write → read → edit → glob → grep → bash, then answers
// Requests without tools (title generation) get a short title.
import http from "node:http"

const PORT = Number(process.env.PORT || 18082)
const STEPS = [
  ["write", { filePath: "notes/hello.txt", content: "hello from the tools\n" }],
  ["read", { filePath: "notes/hello.txt" }],
  ["edit", { filePath: "notes/hello.txt", oldString: "hello", newString: "HELLO" }],
  ["glob", { pattern: "**/*.txt" }],
  ["grep", { pattern: "HELLO" }],
  ["bash", { command: "cat notes/hello.txt; pwd", timeout: 60000 }],
]

http.createServer((req, res) => {
  let b = ""
  req.on("data", (c) => (b += c))
  req.on("end", () => {
    if (req.url.endsWith("/models")) { res.end(JSON.stringify({ data: [{ id: "mock-27b", object: "model" }] })); return }
    const body = JSON.parse(b || "{}")
    const msgs = body.messages ?? []
    res.writeHead(200, { "content-type": "text/event-stream" })
    const send = (o) => res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "mock-27b", ...o })}\n\n`)
    const say = (text) => {
      send({ choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })
      send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
    }
    const callTool = (name, args) => {
      send({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })
      send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })
    }
    if (!(body.tools ?? []).length) say("MAW check")
    else {
      let lastUser = -1
      msgs.forEach((m, i) => { if (m.role === "user") lastUser = i })
      const userText = JSON.stringify(msgs[lastUser]?.content ?? "")
      const done = msgs.slice(lastUser + 1).filter((m) => m.role === "tool").length
      const raw = msgs[lastUser]?.content
      const plain = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((p) => p?.text ?? "").join("\n") : ""
      const calls = [...plain.matchAll(/^CALL (\w+) (\{.*\})\s*$/gm)].map((m) => [m[1], JSON.parse(m[2])])
      if (calls.length) {
        if (done < calls.length) callTool(...calls[done])
        else say("calls done")
        res.write("data: [DONE]\n\n")
        res.end()
        return
      }
      if (/slow/.test(userText)) {
        const words = ["This ", "answer ", "came ", "slowly."]
        let i = 0
        const tick = setInterval(() => {
          if (i < words.length) { send({ choices: [{ index: 0, delta: { role: "assistant", content: words[i++] }, finish_reason: null }] }); return }
          clearInterval(tick)
          send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
          res.write("data: [DONE]\n\n")
          res.end()
        }, 1000)
        return
      }
      if (/\bask\b/.test(userText)) {
        done === 0
          ? callTool("question", { questions: [{ question: "Which branch should I use?", header: "Branch", options: [{ label: "main", description: "The main branch" }, { label: "phase3-1", description: "The Phase 3 branch" }] }] })
          : say(`you chose: ${JSON.stringify(msgs.at(-1)?.content ?? "").slice(0, 200)}`)
      } else if (/git status/.test(userText)) done === 0 ? callTool("bash", { command: "git status --short --branch", timeout: 60000 }) : say("that is the status")
      else if (/sleep/.test(userText)) done === 0 ? callTool("bash", { command: "sleep 30", timeout: 120000 }) : say("stopped")
      else if (done < STEPS.length) callTool(...STEPS[done])
      else say("## Done\n\ndone: **all six tools ran**")
    }
    res.write("data: [DONE]\n\n")
    res.end()
  })
}).listen(PORT, () => console.log(`mock-llm on ${PORT}`))
