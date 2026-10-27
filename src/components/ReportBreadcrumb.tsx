import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { JSX } from "react";

interface ReportBreadcrumbProps {
  sessionId: string;
  substationName: string;
  current: string;
}

const MAX_NAME_CHARS = 24;
const FALLBACK_NAME = "Substation";

function displayName(name: string): string {
  const trimmed = (name ?? "").trim();
  const base = trimmed.length > 0 ? trimmed : FALLBACK_NAME;
  return base.length > MAX_NAME_CHARS ? `${base.slice(0, MAX_NAME_CHARS)}…` : base;
}

// Breadcrumb trail for the report page: Home → substation → workspace → current.
// Truncates long substation names (with full name in title) so the trail
// never wraps at 375px. Empty names fall back to "Substation".
export default function ReportBreadcrumb({
  sessionId,
  substationName,
  current,
}: ReportBreadcrumbProps): JSX.Element {
  const short = displayName(substationName);
  const full = (substationName ?? "").trim() || FALLBACK_NAME;
  const linkClass = "text-slate-500 transition-colors hover:text-white";

  return (
    <nav aria-label="Breadcrumb" className="overflow-hidden">
      <ol className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11px] font-semibold uppercase tracking-[0.14em]">
        <li className="flex items-center gap-1.5">
          <Link href="/" className={linkClass}>
            Home
          </Link>
        </li>
        <li aria-hidden="true" className="flex items-center">
          <ChevronRight className="h-3 w-3 text-slate-600" aria-hidden="true" />
        </li>
        <li className="flex min-w-0 items-center gap-1.5">
          <Link href="/dashboard" title={full} className={`${linkClass} max-w-[120px] truncate`}>
            {short}
          </Link>
        </li>
        <li aria-hidden="true" className="flex items-center">
          <ChevronRight className="h-3 w-3 text-slate-600" aria-hidden="true" />
        </li>
        <li className="flex items-center gap-1.5">
          <Link href={`/inspection/${sessionId}`} className={linkClass}>
            Workspace
          </Link>
        </li>
        <li aria-hidden="true" className="flex items-center">
          <ChevronRight className="h-3 w-3 text-slate-600" aria-hidden="true" />
        </li>
        <li className="flex min-w-0 items-center">
          <span aria-current="page" className="truncate text-slate-200">
            {current}
          </span>
        </li>
      </ol>
    </nav>
  );
}
