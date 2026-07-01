import { captureResource } from "../source-capture.mjs";

export function collectOpenedDocumentMetadata(vaultPath, documents = [], options = {}) {
  return documents.map((item) => captureResource(vaultPath, {
    ...item,
    sourceType: "opened_document",
    userApproved: true,
    contentApproved: false,
    processingStatus: "needs_review",
    recommendedNextAction: "Approve content ingest only if this document is relevant."
  }, options));
}
