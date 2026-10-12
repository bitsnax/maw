// Agent settings, all from the environment (the install file MAW generates).
//
//   MAW_AGENT_ID        machine id; must equal the CN of the agent certificate
//   MAW_AGENT_CERT_PEM  this machine's certificate (issued by MAW's CA)
//   MAW_AGENT_KEY_PEM   its private key (exists only in the install file)
//   MAW_CA_PEM          MAW's CA certificate: only clients it signed get in
//   MAW_RUN_AS          host user commands run as (used from Phase 2)
//   MAW_AGENT_PORT      listen port inside the container (default 7017)
//   MAW_DOCKER_SOCKET   Docker socket path (default /var/run/docker.sock)

import { X509Certificate } from "node:crypto"

export type Config = {
  id: string
  certPem: string
  keyPem: string
  caPem: string
  runAs: string
  port: number
  dockerSocket: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = ["MAW_AGENT_ID", "MAW_AGENT_CERT_PEM", "MAW_AGENT_KEY_PEM", "MAW_CA_PEM"]
    .filter((k) => !env[k]?.trim())
  if (missing.length) throw new Error(`Missing settings: ${missing.join(", ")}`)

  const id = env.MAW_AGENT_ID!.trim()
  const certPem = env.MAW_AGENT_CERT_PEM!
  const port = Number(env.MAW_AGENT_PORT ?? 7017)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MAW_AGENT_PORT is not a valid port")

  // The certificate must be the one MAW issued for this machine id; a
  // pasted file from another machine fails here, not at the first request.
  const cert = new X509Certificate(certPem)
  const cn = /(?:^|\n)CN=([^\n]+)/.exec(cert.subject)?.[1]
  if (cn !== id) throw new Error(`Certificate is for "${cn}", not for MAW_AGENT_ID "${id}"`)

  return {
    id,
    certPem,
    keyPem: env.MAW_AGENT_KEY_PEM!,
    caPem: env.MAW_CA_PEM!,
    runAs: env.MAW_RUN_AS?.trim() ?? "",
    port,
    dockerSocket: env.MAW_DOCKER_SOCKET?.trim() || "/var/run/docker.sock",
  }
}
