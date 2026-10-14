"use client"

import Link from "next/link"
import { Code, CodeLine } from "@/app/components/code"

// The install file view, shared by Add machine and Reissue certificate.
// The file holds the machine's private key and is shown once.

export type InstallFileView = { name: string; address: string; yaml: string; dir: string; image: string }

export default function InstallFile({ view, intro, reissue = false }: { view: InstallFileView; intro: string; reissue?: boolean }) {
  return (
    <div className="install">
      <div className="form-alert form-alert-info">{intro}</div>

      <ol className="install-steps">
        {!reissue && (
          <li>
            On {view.name}, make the agent image available. On the machine that runs MAW it already is; for
            another machine, run this on 192.168.4.201:
            <CodeLine text={`docker save ${view.image} | ssh ${view.address} docker load`} />
          </li>
        )}
        {!reissue && (
          <li>
            On {view.name}, create the folder:
            <CodeLine text={`sudo mkdir -p ${view.dir} && sudo chown $(id -un) ${view.dir}`} />
          </li>
        )}
        <li>
          {reissue ? "On " + view.name + ", replace " : "Save the file below as "}
          <code>{view.dir}/compose.yaml</code>
          {reissue ? " with the file below, then restart the agent:" : ", then start the agent:"}
          <CodeLine text={`cd ${view.dir} && docker compose up -d${reissue ? " --force-recreate" : ""}`} />
        </li>
        <li>
          Open <Link href="/machines">Machines</Link>: {view.name} shows online.
        </li>
      </ol>

      <Code text={view.yaml} lang="yaml" title={`${view.dir}/compose.yaml`} className="install-file" />
    </div>
  )
}
