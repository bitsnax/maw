import Link from "next/link"
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome"
import { faChevronRight } from "@fortawesome/free-solid-svg-icons"

// Shared breadcrumb renderer for any route group with a @breadcrumb slot.
//
// Each route's @breadcrumb slot builds its own trail array (with Prisma
// lookups where needed) and passes it here. The component handles
// markup, classes, and the chevron-separator between items.
//
// The Crumb shape is a discriminated union so the call site can only
// build trails that match three semantic positions:
//
//   - link:    a navigable ancestor (Home, Admin, Users)
//   - soft:    a non-clickable label that isn't the current page
//              (a record's name in an edit trail)
//   - current: the final entry, marked with aria-current="page"
//
// The component places a separator after every item except the last.
// A trail with one entry renders no separators.

export type Crumb =
  | { kind: "link"; href: string; label: string }
  | { kind: "soft"; label: string }
  | { kind: "current"; label: string }

export function Breadcrumbs({ trail }: { trail: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="breadcrumbs">
      <ol className="breadcrumbs-list">
        {trail.map((c, i) => {
          const isLast = i === trail.length - 1
          return (
            <li key={i} className="breadcrumbs-item">
              {c.kind === "link" && (
                <Link href={c.href} className="breadcrumbs-link">{c.label}</Link>
              )}
              {c.kind === "soft" && (
                <span className="breadcrumbs-current-soft">{c.label}</span>
              )}
              {c.kind === "current" && (
                <span className="breadcrumbs-current" aria-current="page">{c.label}</span>
              )}
              {!isLast && (
                <span className="breadcrumbs-separator" aria-hidden="true">
                  <FontAwesomeIcon icon={faChevronRight} />
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
