"use server"

import { revalidatePath } from "next/cache"
import { adminSession } from "@/lib/admin-session"
import { createMachine } from "@/lib/machines"
import { installFile, AGENT_DIR, AGENT_IMAGE } from "@/lib/install-file"

export type AddMachineState =
  | { status: "idle" }
  | { status: "error"; message?: string; errors: Record<string, string>; values: Record<string, string> }
  | { status: "done"; name: string; address: string; yaml: string; dir: string; image: string }

// Returns a state for the form instead of throwing, so a problem shows as a
// readable message rather than Next's generic production error.
export async function addMachine(_prev: AddMachineState, form: FormData): Promise<AddMachineState> {
  const values = {
    name: String(form.get("name") ?? "").trim(),
    address: String(form.get("address") ?? "").trim(),
    port: String(form.get("port") ?? "7017").trim(),
    runAs: String(form.get("runAs") ?? "").trim(),
  }
  const session = await adminSession()
  if (!session) return { status: "error", message: "Only an admin can add machines.", errors: {}, values }

  try {
    const r = await createMachine(
      { name: values.name, address: values.address, port: Number(values.port), runAs: values.runAs },
      session.user.id,
    )
    if (!r.ok) return { status: "error", errors: r.errors, values }
    revalidatePath("/machines")
    return {
      status: "done",
      name: values.name,
      address: values.address,
      yaml: installFile({ name: values.name, address: values.address, port: Number(values.port), runAs: values.runAs }, r.install),
      dir: AGENT_DIR,
      image: AGENT_IMAGE,
    }
  } catch (e) {
    return { status: "error", message: `The machine was not added: ${e instanceof Error ? e.message : String(e)}`, errors: {}, values }
  }
}
