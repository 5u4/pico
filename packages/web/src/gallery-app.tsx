import { useReducer, useState } from "react";
import type {
  AssistantBlock,
  ChatSummary,
  ComposerPresentation,
  ToolCallPresentation,
  TranscriptItem,
  TranscriptPresentation,
  WorkspaceSummary,
} from "./chat/chat-model.ts";
import { ChatScreen } from "./chat/chat-screen.tsx";
import { type GalleryFixture, type GalleryScenarioId, galleryFixtures } from "./chat-fixtures.ts";
import { applyThemePreference, readBootstrappedTheme, type Theme } from "./theme.ts";

interface GalleryState {
  readonly scenarioId: GalleryScenarioId;
  readonly description: string;
  readonly workspace: WorkspaceSummary;
  readonly chats: readonly ChatSummary[];
  readonly activeChatId: string | null;
  readonly transcript: TranscriptPresentation;
  readonly composer: ComposerPresentation;
  readonly sidebarOpen: boolean;
  readonly nextMessageNumber: number;
}

type GalleryAction =
  | { readonly type: "scenario-selected"; readonly scenarioId: GalleryScenarioId }
  | { readonly type: "sidebar-changed"; readonly open: boolean }
  | { readonly type: "chat-selected"; readonly chatId: string }
  | { readonly type: "new-chat-selected" }
  | { readonly type: "composer-changed"; readonly value: string }
  | { readonly type: "message-submitted" }
  | { readonly type: "generation-stopped" }
  | { readonly type: "transcript-retried" }
  | { readonly type: "disclosure-toggled"; readonly itemId: string };

export interface GalleryAppProps {
  readonly designMode: boolean;
}

export function GalleryApp({ designMode }: GalleryAppProps) {
  const [state, dispatch] = useReducer(
    galleryReducer,
    designMode ? fixtureFromLocation() : galleryFixtures[0],
    stateFromFixture,
  );
  const [theme, setTheme] = useState<Theme>(readBootstrappedTheme);

  const selectScenario = (scenarioId: GalleryScenarioId) => {
    const url = new URL(window.location.href);
    url.searchParams.set("scenario", scenarioId);
    window.history.replaceState(null, "", url);
    dispatch({ type: "scenario-selected", scenarioId });
  };
  const changeTheme = (nextTheme: Theme) => {
    applyThemePreference(nextTheme);
    setTheme(nextTheme);
  };

  const screen = (
    <ChatScreen
      activeChatId={state.activeChatId}
      chats={state.chats}
      composer={state.composer}
      onChatSelect={(chatId) => dispatch({ type: "chat-selected", chatId })}
      onComposerSubmit={() => dispatch({ type: "message-submitted" })}
      onComposerValueChange={(value) => dispatch({ type: "composer-changed", value })}
      onDisclosureToggle={(itemId) => dispatch({ type: "disclosure-toggled", itemId })}
      onNewChat={() => dispatch({ type: "new-chat-selected" })}
      onSidebarOpenChange={(open) => dispatch({ type: "sidebar-changed", open })}
      onStop={() => dispatch({ type: "generation-stopped" })}
      onTranscriptRetry={() => dispatch({ type: "transcript-retried" })}
      onThemeChange={changeTheme}
      sidebarOpen={state.sidebarOpen}
      transcript={state.transcript}
      theme={theme}
      workspace={state.workspace}
    />
  );

  if (!designMode) {
    return <div className="h-dvh">{screen}</div>;
  }

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-canvas">
      <header className="shrink-0 border-b border-border bg-panel px-4 py-3">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
          <div className="mr-auto min-w-0">
            <p className="text-label font-semibold">Pico design gallery</p>
            <p className="truncate text-meta text-muted">{state.description}</p>
          </div>
          <label className="text-meta font-medium text-muted" htmlFor="gallery-scenario">
            Scenario
          </label>
          <select
            className="h-9 rounded-control border border-border-strong bg-panel px-3 text-label text-foreground"
            id="gallery-scenario"
            onChange={(event) => {
              const fixture = galleryFixtures.find((item) => item.id === event.currentTarget.value);
              if (fixture) {
                selectScenario(fixture.id);
              }
            }}
            value={state.scenarioId}
          >
            {galleryFixtures.map((fixture) => (
              <option key={fixture.id} value={fixture.id}>
                {fixture.label}
              </option>
            ))}
          </select>
        </div>
      </header>
      <div className="min-h-0 flex-1">{screen}</div>
    </div>
  );
}

function galleryReducer(state: GalleryState, action: GalleryAction): GalleryState {
  switch (action.type) {
    case "scenario-selected":
      return stateFromFixture(findFixture(action.scenarioId));
    case "sidebar-changed":
      return { ...state, sidebarOpen: action.open };
    case "chat-selected":
      return selectChat(state, action.chatId);
    case "new-chat-selected":
      return {
        ...state,
        activeChatId: null,
        transcript: {
          state: "empty",
          title: "Start with the work",
          description:
            "Describe the change, paste the error, or ask pico to inspect the workspace.",
        },
        composer: {
          mode: "send",
          value: "",
          placeholder: "Ask pico to change the workspace",
          editable: true,
          canSubmit: false,
          statusLabel: "New local gallery chat ready.",
        },
      };
    case "composer-changed":
      return { ...state, composer: updateComposerValue(state.composer, action.value) };
    case "message-submitted":
      return submitMessage(state);
    case "generation-stopped":
      return stopGeneration(state);
    case "transcript-retried": {
      const ready = stateFromFixture(galleryFixtures[0]);
      return {
        ...ready,
        composer: {
          ...ready.composer,
          statusLabel: "Loaded the ready transcript fixture.",
        },
      };
    }
    case "disclosure-toggled":
      return {
        ...state,
        transcript: toggleDisclosure(state.transcript, action.itemId),
      };
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

function fixtureFromLocation(): GalleryFixture {
  const requested = new URLSearchParams(window.location.search).get("scenario");
  return requested === null ? galleryFixtures[0] : findFixture(requested);
}

function findFixture(scenarioId: string): GalleryFixture {
  return galleryFixtures.find((fixture) => fixture.id === scenarioId) ?? galleryFixtures[0];
}

function stateFromFixture(fixture: GalleryFixture): GalleryState {
  return {
    scenarioId: fixture.id,
    description: fixture.description,
    workspace: fixture.workspace,
    chats: fixture.chats,
    activeChatId: fixture.activeChatId,
    transcript: fixture.transcript,
    composer: fixture.composer,
    sidebarOpen: false,
    nextMessageNumber: 1,
  };
}

function updateComposerValue(composer: ComposerPresentation, value: string): ComposerPresentation {
  switch (composer.mode) {
    case "send":
      return {
        ...composer,
        value,
        canSubmit: value.trim().length > 0,
        statusLabel:
          value.length > 0
            ? "Draft stored in the gallery."
            : "Enter to send. Shift and Enter for a new line.",
      };
    case "stop":
      return { ...composer, value };
    default: {
      const exhaustive: never = composer;
      return exhaustive;
    }
  }
}

function selectChat(state: GalleryState, chatId: string): GalleryState {
  const chat = state.chats.find((item) => item.id === chatId);
  if (!chat) {
    return state;
  }

  const transcript =
    state.transcript.state === "ready"
      ? { ...state.transcript, liveLabel: `Selected ${chat.title}` }
      : state.transcript;

  return {
    ...state,
    activeChatId: chat.id,
    transcript,
    composer: {
      mode: "send",
      value: "",
      placeholder: "Ask pico to change the workspace",
      editable: true,
      canSubmit: false,
      statusLabel: `Selected ${chat.title}.`,
    },
  };
}

function submitMessage(state: GalleryState): GalleryState {
  if (state.composer.mode !== "send" || !state.composer.canSubmit) {
    return state;
  }

  const text = state.composer.value.trim();
  if (text.length === 0) {
    return state;
  }

  const sequence = state.nextMessageNumber;
  const existingItems = state.transcript.state === "ready" ? state.transcript.items : [];
  const items: readonly TranscriptItem[] = [
    ...existingItems,
    {
      kind: "user",
      id: `gallery-user-${sequence}`,
      text,
      timestampLabel: "Local preview",
    },
    {
      kind: "notice",
      id: `gallery-notice-${sequence}`,
      tone: "info",
      title: "Gallery input recorded",
      text: "This preview stores the message locally. No backend request was made.",
    },
  ];

  return {
    ...state,
    transcript: {
      state: "ready",
      items,
      liveLabel: "Gallery message added",
    },
    composer: {
      mode: "send",
      value: "",
      placeholder: "Ask pico to change the workspace",
      editable: true,
      canSubmit: false,
      statusLabel: "Message added to the local preview.",
    },
    nextMessageNumber: sequence + 1,
  };
}

function stopGeneration(state: GalleryState): GalleryState {
  if (state.composer.mode !== "stop" || !state.composer.canStop) {
    return state;
  }

  return {
    ...state,
    transcript: stopTranscript(state.transcript),
    composer: {
      mode: "send",
      value: state.composer.value,
      placeholder: "Continue from the preserved response",
      editable: true,
      canSubmit: state.composer.value.trim().length > 0,
      statusLabel: "Response stopped. Partial content remains in the transcript.",
    },
  };
}

function stopTranscript(transcript: TranscriptPresentation): TranscriptPresentation {
  if (transcript.state !== "ready") {
    return transcript;
  }

  return {
    ...transcript,
    items: transcript.items.map(stopTranscriptItem),
    liveLabel: "Response stopped",
  };
}

function stopTranscriptItem(item: TranscriptItem): TranscriptItem {
  switch (item.kind) {
    case "user":
    case "notice":
      return item;
    case "assistant":
      return {
        ...item,
        blocks: item.blocks.map(stopAssistantBlock),
        state:
          item.state.kind === "streaming"
            ? { kind: "interrupted", label: "Response stopped. Partial content is preserved." }
            : item.state,
      };
    case "tool-group":
      return { ...item, calls: item.calls.map(stopToolCall) };
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}

function stopAssistantBlock(block: AssistantBlock): AssistantBlock {
  if (block.kind === "thinking" && block.phase === "streaming") {
    return { ...block, phase: "complete" };
  }
  return block;
}

function stopToolCall(call: ToolCallPresentation): ToolCallPresentation {
  if (call.state.kind === "running") {
    return { ...call, state: { kind: "canceled", label: "Canceled" } };
  }
  return call;
}

function toggleDisclosure(
  transcript: TranscriptPresentation,
  itemId: string,
): TranscriptPresentation {
  if (transcript.state !== "ready") {
    return transcript;
  }

  return {
    ...transcript,
    items: transcript.items.map((item) => toggleTranscriptItem(item, itemId)),
  };
}

function toggleTranscriptItem(item: TranscriptItem, itemId: string): TranscriptItem {
  switch (item.kind) {
    case "user":
    case "notice":
      return item;
    case "tool-group":
      return item.id === itemId ? { ...item, open: !item.open } : item;
    case "assistant":
      return {
        ...item,
        blocks: item.blocks.map((block) => toggleAssistantBlock(block, itemId)),
      };
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}

function toggleAssistantBlock(block: AssistantBlock, itemId: string): AssistantBlock {
  if (block.kind === "thinking" && block.id === itemId) {
    return { ...block, open: !block.open };
  }
  return block;
}
