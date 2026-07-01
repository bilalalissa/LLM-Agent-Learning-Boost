import { captureResource } from "../source-capture.mjs";

export function collectManualImport(vaultPath, resource, options = {}) {
  return captureResource(vaultPath, { ...resource, sourceType: "manual_import", userApproved: true }, options);
}
