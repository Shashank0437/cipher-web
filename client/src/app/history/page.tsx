import { redirect } from "next/navigation";

/** Legacy workspace URL kept for bookmarks. Main shell lives at `/dashboard`. */
export default function HistoryRedirectPage() {
  redirect("/dashboard");
}
