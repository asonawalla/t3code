import { sign as signApplication, type SignOptions } from "@electron/osx-sign";

import { loadRepoEnv } from "./lib/public-config.ts";

/** Sign files with matching options together instead of spawning codesign for each file. */
export default async function sign(options: SignOptions): Promise<void> {
  if (options.platform === "darwin" && options.type === "development") {
    const identity = loadRepoEnv().T3CODE_DESKTOP_LOCAL_SIGN_IDENTITY?.trim();
    if (!identity || identity === "-") {
      throw new Error(
        "T3CODE_DESKTOP_LOCAL_SIGN_IDENTITY must name a certificate for local macOS signing.",
      );
    }
    await signApplication({
      ...options,
      identity,
      identityValidation: true,
      preEmbedProvisioningProfile: false,
      preAutoEntitlements: false,
      optionsForFile: (filePath, context) => ({
        ...options.optionsForFile?.(filePath, context),
        timestamp: "none",
      }),
      batchCodesignCalls: true,
    });
    return;
  }
  await signApplication({ ...options, batchCodesignCalls: true });
}
