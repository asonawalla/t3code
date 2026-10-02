import { sign as signApplication, type SignOptions } from "@electron/osx-sign";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import sign from "./sign-macos.ts";
import * as PublicConfig from "./lib/public-config.ts";

vi.mock("@electron/osx-sign", () => ({ sign: vi.fn() }));

beforeEach(() => {
  vi.spyOn(PublicConfig, "loadRepoEnv").mockReturnValue({});
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

it("batches codesign calls without changing existing signing options", async () => {
  vi.mocked(PublicConfig.loadRepoEnv).mockReturnValue({
    T3CODE_DESKTOP_LOCAL_SIGN_IDENTITY: "local-development-identity",
  });
  const options = {
    app: "/tmp/T3 Code.app",
    identity: "Developer ID Application: T3 Tools, Inc.",
    keychain: "/tmp/t3code.keychain",
    provisioningProfile: "/tmp/t3code.provisionprofile",
    optionsForFile: () => ({
      entitlements: "/tmp/t3code.entitlements.plist",
      hardenedRuntime: true,
    }),
  } satisfies SignOptions;

  await sign(options);

  expect(signApplication).toHaveBeenCalledExactlyOnceWith({
    ...options,
    batchCodesignCalls: true,
  });
});

it.each(["-", "another-certificate-hash"])(
  "uses the configured local identity when builder selects %s",
  async (builderIdentity) => {
    vi.mocked(PublicConfig.loadRepoEnv).mockReturnValue({
      T3CODE_DESKTOP_LOCAL_SIGN_IDENTITY: "  local-development-identity  ",
    });
    const options = {
      app: "/tmp/T3 Code.app",
      platform: "darwin",
      type: "development",
      identity: builderIdentity,
      identityValidation: false,
      optionsForFile: () => ({
        entitlements: "/tmp/existing-entitlements.plist",
        hardenedRuntime: true,
      }),
    } satisfies SignOptions;

    await sign(options);

    expect(signApplication).toHaveBeenCalledExactlyOnceWith({
      ...options,
      identity: "local-development-identity",
      identityValidation: true,
      preEmbedProvisioningProfile: false,
      preAutoEntitlements: false,
      optionsForFile: expect.any(Function),
      batchCodesignCalls: true,
    });
    const signedOptions = vi.mocked(signApplication).mock.calls[0]![0];
    expect(signedOptions.optionsForFile?.("/tmp/T3 Code.app", { platform: "darwin" })).toEqual({
      entitlements: "/tmp/existing-entitlements.plist",
      hardenedRuntime: true,
      timestamp: "none",
    });
  },
);

it.each([undefined, " ", "-"])(
  "refuses local development signing without a certificate (%j)",
  async (identity) => {
    vi.mocked(PublicConfig.loadRepoEnv).mockReturnValue({
      T3CODE_DESKTOP_LOCAL_SIGN_IDENTITY: identity,
    });
    await expect(
      sign({ app: "/tmp/T3 Code.app", platform: "darwin", type: "development", identity: "-" }),
    ).rejects.toThrow("T3CODE_DESKTOP_LOCAL_SIGN_IDENTITY must name a certificate");
    expect(signApplication).not.toHaveBeenCalled();
  },
);
