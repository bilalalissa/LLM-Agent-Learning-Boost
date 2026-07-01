import { captureResource } from "../source-capture.mjs";

export function collectMeetingResources(vaultPath, meetings = [], options = {}) {
  return meetings.map((item) => captureResource(vaultPath, {
    ...item,
    sourceType: "meeting",
    topic: item.topic || "Meetings",
    processingStatus: item.file ? "ready_for_ingest" : "needs_review",
    recommendedNextAction: item.file
      ? "Review transcript rights and ingest when approved."
      : "Import a transcript or recording only if you have rights."
  }, options));
}
