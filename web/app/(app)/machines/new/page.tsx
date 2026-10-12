import Link from "next/link"
import AddMachineForm from "./AddMachineForm"

export default function NewMachinePage() {
  return (
    <>
      <div className="page-head">
        <h1 className="app-title">Add machine</h1>
        <Link href="/machines" className="btn">Back to machines</Link>
      </div>
      <AddMachineForm />
    </>
  )
}
