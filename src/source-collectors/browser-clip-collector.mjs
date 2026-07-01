import { captureResource } from "../source-capture.mjs";

export function collectBrowserClip(vaultPath, resource, options = {}) {
  return captureResource(vaultPath, { ...resource, sourceType: "browser_clip", userApproved: true, contentApproved: true }, options);
}
