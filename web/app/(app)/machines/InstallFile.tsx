"use client"

import Link from "next/link"
import { useState } from "react"

// The install file view, shared by Add machine and Reissue certificate.
// The file holds the machine's private key and is shown once.

export type InstallFileView = { name: string; address: string; yaml: string; dir: string; image: string }

export default function InstallFile({ view, intro, reissue = false }: { view: InstallFileView; intro: string; reissue?: boolean }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(view.yaml)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="install">
      <div className="form-alert form-alert-info">{intro}</div>

      <ol className="install-steps">
        {!reissue && (
          <li>
            On {view.name}, make the agent image available. On the machine that runs MAW it already is; for
            another machine, run this on 192.168.4.201:
            <pre className="code-line">docker save {view.image} | ssh {view.address} docker load</pre>
          </li>
        )}
        {!reissue && (
          <li>
            On {view.name}, create the folder:
            <pre className="code-line">sudo mkdir -p {view.dir} && sudo chown $(id -un) {view.dir}</pre>
          </li>
        )}
        <li>
          {reissue ? "On " + view.name + ", replace " : "Save the file below as "}
          <code>{view.dir}/compose.yaml</code>
          {reissue ? " with the file below, then restart the agent:" : ", then start the agent:"}
          <pre className="code-line">cd {view.dir} && docker compose up -d{reissue ? " --force-recreate" : ""}</pre>
        </li>
        <li>
          Open <Link href="/machines">Machines</Link>: {view.name} shows online.
        </li>
      </ol>

      <div className="code-head">
        <span className="data-mono">{view.dir}/compose.yaml</span>
        <button type="button" className="btn btn-primary" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
      </div>
      <pre className="code-block">{view.yaml}</pre>
    </div>
  )
}
