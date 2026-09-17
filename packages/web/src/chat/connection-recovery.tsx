import { Button } from "../components/ui/button.tsx";

interface ConnectionRecoveryProps {
  readonly connection: "opening" | "active" | "unavailable";
  readonly recovery:
    | readonly {
        readonly key: string;
        readonly label: string;
        readonly text: string;
      }[]
    | null;
  readonly onReload: () => void;
  readonly onKeepEditing: () => void;
  readonly onDiscardAndReload: () => void;
}

export function ConnectionRecovery({
  connection,
  recovery,
  onReload,
  onKeepEditing,
  onDiscardAndReload,
}: ConnectionRecoveryProps) {
  const unavailable = connection === "unavailable";
  return (
    <>
      {connection !== "active" && (
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-panel px-4 py-3 text-label">
          <p className="min-w-0 flex-1" role={unavailable ? "alert" : "status"}>
            {unavailable
              ? "Connection unavailable. Responses and drafts are kept here. Try Reload. If pico restarted, open the new URL from its startup log."
              : "Opening connection to pico..."}
          </p>
          {unavailable && (
            <Button onClick={onReload} size="small" tone="secondary">
              Reload
            </Button>
          )}
        </div>
      )}
      {recovery !== null && (
        <section
          aria-label="Save drafts before reloading"
          className="max-h-[60dvh] shrink-0 overflow-y-auto border-b border-border bg-panel p-4"
        >
          <h2 className="text-title font-semibold">Save drafts before reloading</h2>
          <p className="mt-1 text-label text-muted">
            Copy any drafts you want to keep. Reloading clears unsent text.
          </p>
          {recovery.map((entry) => (
            <label className="mt-3 block text-label" key={entry.key}>
              {entry.label}
              <textarea
                className="mt-1 block min-h-24 w-full rounded-control border border-border bg-canvas p-3 text-base"
                readOnly
                value={entry.text}
              />
            </label>
          ))}
          <div className="mt-3 flex flex-wrap gap-3">
            <Button onClick={onKeepEditing} size="small" tone="secondary">
              Keep editing
            </Button>
            <Button onClick={onDiscardAndReload} size="small" tone="danger">
              Discard drafts and reload
            </Button>
          </div>
        </section>
      )}
    </>
  );
}
