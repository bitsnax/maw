import { isIP } from "node:net"
import type { InstallBundle } from "./machines"

// The compose.yaml shown by Add machine (and later Reissue certificate).
// It holds the machine's private key, so it is shown once and never stored.

export const AGENT_IMAGE = "maw-agent:0.1.0"
export const AGENT_DIR = "/opt/maw-agent"

function block(pem: string, indent: string): string {
  return pem.trimEnd().split("\n").map((l) => indent + l).join("\n")
}

export function installFile(
  m: { name: string; address: string; port: number; runAs: string },
  b: InstallBundle,
  issuedAt = new Date(),
): string {
  // Publish on the machine's LAN address only, so the agent is not offered
  // on every interface (Dozzle's 7007 is). A host name cannot be used in a
  // port binding; then the port is published on all interfaces.
  const publish = isIP(m.address) ? `"${m.address}:${m.port}:7017"` : `"${m.port}:7017"`
  const i = "        "
  return `# maw-agent for ${m.name} (${m.address}) — issued ${issuedAt.toISOString().slice(0, 10)} by MAW
# Contains this machine's private key: keep it on ${m.name} only.
# Save as ${AGENT_DIR}/compose.yaml, then run: docker compose up -d
services:
  maw-agent:
    image: ${AGENT_IMAGE}
    container_name: maw-agent
    restart: unless-stopped
    pid: host            # commands run on the host (from Phase 2)
    privileged: true     # enter the host's namespaces (from Phase 2)
    environment:
      MAW_AGENT_ID: "${b.machineId}"
      MAW_RUN_AS: "${m.runAs}"
      MAW_AGENT_CERT_PEM: |
${block(b.certPem, i)}
      MAW_AGENT_KEY_PEM: |
${block(b.keyPem, i)}
      MAW_CA_PEM: |
${block(b.caPem, i)}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /opt:/opt
    ports:
      - ${publish}
`
}
