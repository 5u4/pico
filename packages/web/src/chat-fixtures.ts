import type {
  ChatSummary,
  ComposerPresentation,
  TranscriptItem,
  TranscriptPresentation,
  WorkspaceSummary,
} from "./chat/chat-model.ts";

export type GalleryScenarioId =
  | "ready"
  | "streaming"
  | "loading"
  | "empty"
  | "error"
  | "interrupted"
  | "stress";

export interface GalleryFixture {
  readonly id: GalleryScenarioId;
  readonly label: string;
  readonly description: string;
  readonly workspace: WorkspaceSummary;
  readonly chats: readonly ChatSummary[];
  readonly activeChatId: string | null;
  readonly transcript: TranscriptPresentation;
  readonly composer: ComposerPresentation;
}

const workspace = {
  id: "workspace-pico",
  name: "pico",
  contextLabel: "Local workspace",
} satisfies WorkspaceSummary;

const chats = [
  {
    id: "chat-navigation",
    title: "Responsive navigation",
    preview: "Refine the mobile workspace drawer",
    updatedLabel: "Recent",
    activity: "idle",
  },
  {
    id: "chat-streaming",
    title: "Transcript states",
    preview: "Render partial output honestly",
    updatedLabel: "In progress",
    activity: "running",
  },
  {
    id: "chat-errors",
    title: "Error recovery",
    preview: "Keep completed context visible",
    updatedLabel: "Needs review",
    activity: "failed",
  },
] satisfies readonly ChatSummary[];

const openingUser = {
  kind: "user",
  id: "user-layout-request",
  text: "Make the chat screen feel calmer. Keep the transcript central and move navigation out of the way on mobile.",
  timestampLabel: "10:14",
} satisfies TranscriptItem;

const openingAssistant = {
  kind: "assistant",
  id: "assistant-plan",
  blocks: [
    {
      kind: "thinking",
      id: "thinking-layout",
      label: "Layout reasoning",
      text: "The transcript is the primary task surface. A fixed desktop sidebar and controlled mobile overlay keep navigation available without reducing the reading measure.",
      open: false,
      phase: "complete",
    },
    {
      kind: "text",
      id: "text-layout-plan",
      text: "I will keep the screen to two regions. The main column will hold a quiet header, the ordered transcript, and one elevated composer.",
    },
  ],
  state: { kind: "complete" },
  timestampLabel: "10:15",
  modelLabel: "pico",
} satisfies TranscriptItem;

const completedTools = {
  kind: "tool-group",
  id: "tools-layout",
  title: "Inspected the current interface",
  open: false,
  calls: [
    {
      id: "tool-read-screen",
      icon: "file",
      label: "Read screen structure",
      summary: "Reviewed the existing page regions",
      state: { kind: "succeeded", label: "Done" },
    },
    {
      id: "tool-search-styles",
      icon: "search",
      label: "Find shared styles",
      summary: "Located the current visual token owners",
      state: { kind: "succeeded", label: "Done" },
    },
  ],
} satisfies TranscriptItem;

const finalAssistant = {
  kind: "assistant",
  id: "assistant-result",
  blocks: [
    {
      kind: "text",
      id: "text-result",
      text: "The revised layout gives the conversation a stable reading width while the sidebar remains useful rather than dominant. On narrow screens, the same navigation opens as an overlay and closes after a chat is selected.",
    },
    {
      kind: "code",
      id: "code-layout",
      languageLabel: "TypeScript",
      code: 'type ScreenRegion =\n  | { readonly kind: "sidebar" }\n  | { readonly kind: "conversation" };',
    },
    {
      kind: "image",
      id: "image-layout",
      src: "/interface-study.svg",
      alt: "Wireframe of a left sidebar and one chat column",
      caption: "Accepted two-region screen study",
    },
  ],
  state: { kind: "complete" },
  timestampLabel: "10:16",
  modelLabel: "pico",
} satisfies TranscriptItem;

const readyTranscript = {
  state: "ready",
  items: [openingUser, openingAssistant, completedTools, finalAssistant],
  liveLabel: "Response complete",
} satisfies TranscriptPresentation;

const readyComposer = {
  mode: "send",
  value: "",
  placeholder: "Ask pico to change the workspace",
  editable: true,
  canSubmit: false,
  statusLabel: "Enter to send. Shift and Enter for a new line.",
} satisfies ComposerPresentation;

const streamingTranscript = {
  state: "ready",
  items: [
    openingUser,
    openingAssistant,
    {
      kind: "tool-group",
      id: "tools-streaming",
      title: "Checking responsive behavior",
      open: true,
      calls: [
        {
          id: "tool-mobile",
          icon: "terminal",
          label: "Inspect narrow viewport",
          summary: "Checking the controlled sidebar overlay",
          state: { kind: "succeeded", label: "Done" },
        },
        {
          id: "tool-keyboard",
          icon: "generic",
          label: "Review keyboard flow",
          summary: "Checking composer and disclosure controls",
          state: { kind: "running", label: "Running" },
        },
      ],
    },
    {
      kind: "assistant",
      id: "assistant-streaming",
      blocks: [
        {
          kind: "thinking",
          id: "thinking-streaming",
          label: "Implementation notes",
          text: "The mobile menu remains caller-controlled. The composer uses a local composition ref so an IME confirmation cannot submit the form.",
          open: true,
          phase: "streaming",
        },
        {
          kind: "text",
          id: "text-streaming",
          text: "The narrow layout now preserves the transcript width and keeps the composer anchored below the scroll region. I am checking the final interaction states",
        },
      ],
      state: { kind: "streaming", label: "Responding" },
      timestampLabel: "10:19",
      modelLabel: "pico",
    },
  ],
  liveLabel: "Pico is responding",
} satisfies TranscriptPresentation;

const interruptedTranscript = {
  state: "ready",
  items: [
    openingUser,
    openingAssistant,
    {
      kind: "tool-group",
      id: "tools-interrupted",
      title: "Checked interface files",
      open: true,
      calls: [
        {
          id: "tool-interrupted-read",
          icon: "file",
          label: "Read navigation component",
          summary: "The existing content remains available",
          state: { kind: "succeeded", label: "Done" },
        },
        {
          id: "tool-interrupted-edit",
          icon: "edit",
          label: "Update transcript spacing",
          summary: "Stopped before the change was applied",
          state: { kind: "canceled", label: "Canceled" },
        },
      ],
    },
    {
      kind: "assistant",
      id: "assistant-interrupted",
      blocks: [
        {
          kind: "text",
          id: "text-interrupted",
          text: "The completed inspection is preserved. The spacing update was not applied, so the next response can continue from this exact point.",
        },
      ],
      state: { kind: "interrupted", label: "Response stopped. Partial content is preserved." },
      timestampLabel: "10:20",
      modelLabel: "pico",
    },
  ],
  liveLabel: "Response stopped",
} satisfies TranscriptPresentation;

const stressChats = [
  ...chats,
  {
    id: "chat-long-label",
    title: "A very long chat title that checks truncation without hiding navigation state",
    preview: "Long preview copy confirms that the sidebar remains compact under pressure",
    updatedLabel: "Archived",
    activity: "idle",
  },
] satisfies readonly ChatSummary[];

const stressItems = [
  openingUser,
  openingAssistant,
  completedTools,
  finalAssistant,
  {
    kind: "user",
    id: "stress-user-one",
    text: "Check overflow with a long command and keep it readable without expanding the page width.",
    timestampLabel: "10:22",
  },
  {
    kind: "assistant",
    id: "stress-code",
    blocks: [
      {
        kind: "text",
        id: "stress-code-intro",
        text: "The code block scrolls inside its own boundary. Transcript prose keeps the same measure.",
      },
      {
        kind: "code",
        id: "stress-code-block",
        languageLabel: "Shell",
        code: "bun --cwd packages/web run preview --host 127.0.0.1 --strictPort --port 4173\nprintf '%s\\n' 'a deliberately long output line that stays inside the typed code block instead of widening the transcript column'",
      },
    ],
    state: { kind: "complete" },
    timestampLabel: "10:23",
    modelLabel: "pico",
  },
  {
    kind: "notice",
    id: "stress-notice",
    tone: "warning",
    title: "Review required",
    text: "The gallery shows presentation behavior only. It does not connect to a workspace backend.",
  },
  {
    kind: "tool-group",
    id: "stress-tools",
    title: "Mixed tool results with long summaries",
    open: true,
    calls: [
      {
        id: "stress-tool-one",
        icon: "network",
        label: "Inspect service boundary",
        summary:
          "Confirmed that production components contain no request or transport dependencies",
        state: { kind: "succeeded", label: "Done" },
      },
      {
        id: "stress-tool-two",
        icon: "terminal",
        label: "Run unavailable command",
        summary: "The fixture records a visible failure without fabricating command output",
        state: { kind: "failed", label: "Failed" },
      },
    ],
  },
  {
    kind: "assistant",
    id: "stress-final",
    blocks: [
      {
        kind: "text",
        id: "stress-final-text",
        text: "Long labels truncate at navigation boundaries. Multiline prose wraps in the transcript, and typed code keeps horizontal overflow local. The final composer remains the only elevated surface.",
      },
    ],
    state: { kind: "complete" },
    timestampLabel: "10:24",
    modelLabel: "pico",
  },
] satisfies readonly TranscriptItem[];

export const galleryFixtures = [
  {
    id: "ready",
    label: "Ready",
    description: "Completed conversation with every core content block.",
    workspace,
    chats,
    activeChatId: "chat-navigation",
    transcript: readyTranscript,
    composer: readyComposer,
  },
  {
    id: "streaming",
    label: "Streaming",
    description: "Partial assistant content and running grouped tools.",
    workspace,
    chats,
    activeChatId: "chat-streaming",
    transcript: streamingTranscript,
    composer: {
      mode: "stop",
      value: "",
      placeholder: "Add context while pico responds",
      editable: true,
      canStop: true,
      statusLabel: "Pico is responding. Partial content stays visible if stopped.",
    },
  },
  {
    id: "loading",
    label: "Loading",
    description: "Transcript loading without a fabricated progress estimate.",
    workspace,
    chats,
    activeChatId: "chat-navigation",
    transcript: { state: "loading", label: "Loading conversation" },
    composer: {
      mode: "send",
      value: "",
      placeholder: "Conversation is loading",
      editable: false,
      canSubmit: false,
      statusLabel: "Waiting for the conversation.",
    },
  },
  {
    id: "empty",
    label: "Empty",
    description: "A selected new chat with a ready composer.",
    workspace,
    chats,
    activeChatId: null,
    transcript: {
      state: "empty",
      title: "Start with the work",
      description: "Describe the change, paste the error, or ask pico to inspect the workspace.",
    },
    composer: readyComposer,
  },
  {
    id: "error",
    label: "Error",
    description: "A bounded transcript load error with an explicit recovery action.",
    workspace,
    chats,
    activeChatId: "chat-errors",
    transcript: {
      state: "error",
      title: "Conversation unavailable",
      description:
        "Pico could not load this transcript. The sidebar and recovery action remain available.",
      retryLabel: "Load ready fixture",
    },
    composer: {
      mode: "send",
      value: "",
      placeholder: "Conversation is unavailable",
      editable: false,
      canSubmit: false,
      statusLabel: "Load the conversation before sending.",
    },
  },
  {
    id: "interrupted",
    label: "Interrupted",
    description: "Stopped work keeps completed tools and partial assistant content.",
    workspace,
    chats,
    activeChatId: "chat-errors",
    transcript: interruptedTranscript,
    composer: readyComposer,
  },
  {
    id: "stress",
    label: "Stress",
    description: "Long labels, multiline output, mixed tools, and local code overflow.",
    workspace: {
      id: "workspace-long",
      name: "pico interface research and implementation workspace",
      contextLabel: "Local workspace with a deliberately long display name",
    },
    chats: stressChats,
    activeChatId: "chat-long-label",
    transcript: {
      state: "ready",
      items: stressItems,
      liveLabel: "Stress fixture ready",
    },
    composer: {
      mode: "send",
      value: "A multiline draft remains caller-owned.\nShift and Enter adds this second line.",
      placeholder: "Ask pico to change the workspace",
      editable: true,
      canSubmit: true,
      statusLabel: "Long draft ready to send.",
    },
  },
] satisfies readonly [GalleryFixture, ...GalleryFixture[]];
