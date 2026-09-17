import { Button } from "../components/ui/button.tsx";

interface ConnectionRecoveryProps {
  readonly connection: "opening" | "active" | "unavailable";
  readonly onRetry: () => void;
  readonly orphanDrafts: readonly {
    readonly key: string;
    readonly label: string;
    readonly text: string;
  }[];
}

export function ConnectionRecovery({ connection, onRetry, orphanDrafts }: ConnectionRecoveryProps) {
  const unavailable = connection === "unavailable";
  return (
    <>
      {connection !== "active" && (
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-panel px-4 py-3 text-label">
          <p className="min-w-0 flex-1" role={unavailable ? "alert" : "status"}>
            {unavailable
              ? "Connection unavailable. Responses and drafts are kept here."
              : "Opening connection to pico..."}
          </p>
          {unavailable && (
            <Button onClick={onRetry} size="small" tone="secondary">
              Retry connection
            </Button>
          )}
        </div>
      )}
      {orphanDrafts.length > 0 && (
        <section
          aria-label="Drafts from removed workspaces"
          className="max-h-[60dvh] shrink-0 overflow-y-auto border-b border-border bg-panel p-4"
        >
          <h2 className="text-title font-semibold">Drafts from removed workspaces</h2>
          <p className="mt-1 text-label text-muted">
            These workspaces are no longer available. You can copy your drafts below.
          </p>
          {orphanDrafts.map((entry) => (
            <label className="mt-3 block text-label" key={entry.key}>
              {entry.label}
              <textarea
                className="mt-1 block min-h-24 w-full rounded-control border border-border bg-canvas p-3 text-base"
                readOnly
                value={entry.text}
              />
            </label>
          ))}
        </section>
      )}
    </>
  );
}
