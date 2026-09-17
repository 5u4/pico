import { ChatId } from "@pico/contract/chat-model";
import { WorkspaceId } from "@pico/contract/workspace-model";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  useRouterState,
} from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { FunctionComponent } from "react";

export type ConversationPage =
  | { readonly kind: "draft"; readonly workspaceId: WorkspaceId; readonly tabKey: string | null }
  | { readonly kind: "chat"; readonly workspaceId: WorkspaceId; readonly chatId: ChatId };

export type Page =
  | ConversationPage
  | { readonly kind: "home" }
  | { readonly kind: "schedules" }
  | { readonly kind: "new-workspace" }
  | { readonly kind: "settings"; readonly workspaceId: WorkspaceId; readonly tabKey: string | null }
  | { readonly kind: "invalid" };

const decodeWorkspaceId = Schema.decodeUnknownOption(WorkspaceId);
const decodeChatId = Schema.decodeUnknownOption(ChatId);
const decodeTabKey = Schema.decodeUnknownOption(Schema.String.check(Schema.isUUID()));
const validateTabSearch = (search: Record<string, unknown>): { tab?: string | undefined } => ({
  tab: Option.getOrUndefined(decodeTabKey(search.tab)),
});

export function createAppRouter(component: FunctionComponent) {
  const visit = { current: 0 };
  const root = createRootRouteWithContext<{ readonly visit: typeof visit }>()({
    component,
    notFoundComponent: component,
  });
  const routeTree = root.addChildren([
    createRoute({ getParentRoute: () => root, path: "/" }),
    createRoute({ getParentRoute: () => root, path: "/schedules" }),
    createRoute({ getParentRoute: () => root, path: "/workspaces/new" }),
    createRoute({
      getParentRoute: () => root,
      path: "/workspaces/$workspaceId",
      validateSearch: validateTabSearch,
    }),
    createRoute({ getParentRoute: () => root, path: "/workspaces/$workspaceId/chats/$chatId" }),
    createRoute({
      getParentRoute: () => root,
      path: "/workspaces/$workspaceId/settings",
      validateSearch: validateTabSearch,
    }),
    createRoute({ getParentRoute: () => root, path: "$" }),
  ]);
  const router = createRouter({ routeTree, context: { visit }, caseSensitive: true });
  router.subscribe("onBeforeNavigate", () => {
    visit.current++;
  });
  return router;
}

export function pageFromMatches(
  matches: readonly {
    readonly routeId: string;
    readonly params: Readonly<Record<string, unknown>>;
    readonly search: { readonly tab?: string | undefined };
  }[],
): Page {
  const match = matches.at(-1);
  if (!match) return { kind: "invalid" };
  switch (match.routeId) {
    case "/":
      return { kind: "home" };
    case "/schedules":
      return { kind: "schedules" };
    case "/workspaces/new":
      return { kind: "new-workspace" };
    case "/workspaces/$workspaceId":
    case "/workspaces/$workspaceId/chats/$chatId":
    case "/workspaces/$workspaceId/settings": {
      const workspaceId = decodeWorkspaceId(match.params.workspaceId);
      if (Option.isNone(workspaceId)) return { kind: "invalid" };
      if (match.routeId === "/workspaces/$workspaceId/settings") {
        return {
          kind: "settings",
          workspaceId: workspaceId.value,
          tabKey: match.search.tab ?? null,
        };
      }
      if (match.routeId === "/workspaces/$workspaceId") {
        return { kind: "draft", workspaceId: workspaceId.value, tabKey: match.search.tab ?? null };
      }
      const chatId = decodeChatId(match.params.chatId);
      return Option.isNone(chatId)
        ? { kind: "invalid" }
        : { kind: "chat", workspaceId: workspaceId.value, chatId: chatId.value };
    }
    default:
      return { kind: "invalid" };
  }
}

export function usePage(): Page {
  return useRouterState({ select: (state) => pageFromMatches(state.matches) });
}
