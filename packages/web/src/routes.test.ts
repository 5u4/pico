import { assert, describe, it } from "@effect/vitest";
import { WorkspaceId } from "@pico/contract/workspace-model";
import { createAppRouter, pageFromMatches } from "./routes.tsx";

const workspaceId = WorkspaceId.make("01900000-0000-7000-8000-000000000001");
const firstTab = "8b8d1182-3294-4d89-8f29-8f8f4786f102";
const secondTab = "a377d1f8-b145-4582-97b2-f1e1c1db221a";

describe("New tab routes", () => {
  it("distinguishes New tabs in one workspace and carries the settings return identity", () => {
    const router = createAppRouter(() => null);
    const path = `/workspaces/${workspaceId}`;

    assert.deepStrictEqual(pageFromMatches(router.matchRoutes(path, { tab: firstTab })), {
      kind: "draft",
      workspaceId,
      tabKey: firstTab,
    });
    assert.deepStrictEqual(pageFromMatches(router.matchRoutes(path, { tab: secondTab })), {
      kind: "draft",
      workspaceId,
      tabKey: secondTab,
    });
    assert.deepStrictEqual(
      pageFromMatches(router.matchRoutes(`${path}/settings`, { tab: secondTab })),
      { kind: "settings", workspaceId, tabKey: secondTab },
    );
  });

  it("removes invalid identities instead of inheriting the router's raw search", () => {
    const router = createAppRouter(() => null);
    const path = `/workspaces/${workspaceId}`;

    assert.deepStrictEqual(pageFromMatches(router.matchRoutes(path, { tab: "old-tab:1" })), {
      kind: "draft",
      workspaceId,
      tabKey: null,
    });
    assert.deepStrictEqual(
      pageFromMatches(router.matchRoutes(`${path}/settings`, { tab: [firstTab, secondTab] })),
      { kind: "settings", workspaceId, tabKey: null },
    );
  });
});
