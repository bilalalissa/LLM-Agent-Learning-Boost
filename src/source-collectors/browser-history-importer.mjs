import { captureResource } from "../source-capture.mjs";

export function importBrowserHistoryPreview(vaultPath, items = [], options = {}) {
  if (options.previewApproved !== true) {
    return items.map((item) => ({ captured: false, reason: "Browser history import requires explicit preview approval.", preview: item }));
  }
  return items.map((item) => captureResource(vaultPath, {
    ...item,
    sourceType: "browser_history",
    userApproved: true,
    contentApproved: false,
    processingStatus: "needs_review",
    recommendedNextAction: "Review this history item before ingesting page content."
  }, options));
}
