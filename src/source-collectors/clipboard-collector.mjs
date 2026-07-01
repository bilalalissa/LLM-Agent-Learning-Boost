import { captureResource } from "../source-capture.mjs";

export function collectClipboardResource(vaultPath, clipboard, options = {}) {
  return captureResource(vaultPath, {
    title: clipboard?.title || "Clipboard capture",
    description: clipboard?.description || "Clipboard metadata capture",
    sourceType: "clipboard",
    userApproved: options.previewApproved === true,
    contentApproved: false,
    processingStatus: "needs_review",
    recommendedNextAction: "Review clipboard preview before ingesting content."
  }, options);
}
